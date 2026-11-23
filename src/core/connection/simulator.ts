import type { Connection } from './types'
import { Emitter1 } from './types'

interface Block {
  x: number
  y: number
  /** machine coords at start, filled in when the block begins executing */
  x0: number
  y0: number
  feedMmMin: number
  s: number
  laser: boolean
  dwell?: number
  jog?: boolean
  /** seconds of simulated time left */
  remaining: number
  duration: number
}

export interface TraceSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  s: number
  rapid: boolean
}

export interface SimOptions {
  /** Simulated seconds per real second. */
  speedFactor?: number
  rxSize?: number
  plannerSize?: number
}

/**
 * A virtual GRBL 1.1 laser controller with a 128 byte RX buffer and a 16 block planner.
 * It exists so the streamer, the UI and the generator can be tested without burning anything.
 * It flags any byte-counting violation (`overflowed`) the way a real board would drop characters.
 */
export class SimulatorConnection implements Connection {
  readonly kind = 'simulator' as const
  readonly label = 'Virtual GRBL (simulator)'
  isOpen = false

  /** True if the host ever put more than rxSize bytes in flight. */
  overflowed = false
  readonly trace: TraceSegment[] = []
  /** Every line accepted, in order. */
  readonly accepted: string[] = []
  maxLaserS = 0

  private data = new Emitter1<string>()
  private closeEv = new Emitter1<Error | undefined>()
  private timer?: ReturnType<typeof setInterval>
  private lastTick = 0

  private state: 'Idle' | 'Run' | 'Hold' | 'Alarm' | 'Jog' | 'Home' = 'Idle'
  private mx = 0
  private my = 0
  private wco = { x: 0, y: 0 }
  private relative = false
  private motion: 0 | 1 = 0
  private feed = 1000
  private s = 0
  private spindle: 'off' | 'M3' | 'M4' = 'off'
  private rapidMmMin = 6000
  private rxLines: { text: string; bytes: number }[] = []
  private rxPartial = ''
  private rxUsed = 0
  private planner: Block[] = []
  private current: Block | null = null
  private statusCount = 0
  private ov = { feed: 100, rapid: 100, spindle: 100 }
  private failures: { re: RegExp; code: number }[] = []
  private settings: Record<number, string> = { 30: '1000', 31: '0', 32: '1', 110: '6000', 111: '6000', 130: '400', 131: '415' }
  private speed: number
  private rxSize: number
  private plannerSize: number

  constructor(opts: SimOptions = {}) {
    this.speed = opts.speedFactor ?? 50
    this.rxSize = opts.rxSize ?? 128
    this.plannerSize = opts.plannerSize ?? 15
  }

  async open() {
    this.isOpen = true
    this.lastTick = performance.now()
    this.timer = setInterval(() => this.tick(), 2)
    // GRBL prints its banner on connect (the board resets when the port opens).
    setTimeout(() => this.send('\r\nGrbl 1.1h [\'$\' for help]\r\n'), 5)
  }

  async close() {
    this.isOpen = false
    if (this.timer) clearInterval(this.timer)
    this.closeEv.emit(undefined)
  }

  onData(cb: (c: string) => void) {
    return this.data.on(cb)
  }
  onClose(cb: (e?: Error) => void) {
    return this.closeEv.on(cb)
  }

  // ----- test helpers -----
  failOn(re: RegExp, code: number) {
    this.failures.push({ re, code })
  }
  triggerAlarm(code: number) {
    this.planner = []
    this.current = null
    this.rxLines = []
    this.rxUsed = 0
    this.state = 'Alarm'
    this.send(`ALARM:${code}\r\n`)
  }
  /** Simulate pulling the USB cable. */
  yank() {
    this.isOpen = false
    if (this.timer) clearInterval(this.timer)
    this.closeEv.emit(new Error('Device disconnected'))
  }
  get position() {
    return { x: this.mx, y: this.my }
  }
  get machineState() {
    return this.state
  }
  get busy() {
    return this.planner.length > 0 || this.current !== null || this.rxLines.length > 0
  }

  // ----- wire -----
  private send(s: string) {
    if (this.isOpen) this.data.emit(s)
  }

  write(chunk: string) {
    for (const ch of chunk) {
      const code = ch.charCodeAt(0)
      if (ch === '?') this.reportStatus()
      else if (ch === '!') {
        if (this.state === 'Run' || this.state === 'Jog') this.state = 'Hold'
      } else if (ch === '~') {
        if (this.state === 'Hold') this.state = this.current || this.planner.length ? 'Run' : 'Idle'
      } else if (ch === '\x18') this.softReset()
      else if (ch === '\x85') {
        if (this.state === 'Jog' || this.current?.jog) {
          this.current = null
          this.planner = this.planner.filter((b) => !b.jog)
          this.state = 'Idle'
        }
      } else if (code >= 0x90 && code <= 0x9d) this.override(code)
      else if (ch === '\n') {
        const text = this.rxPartial
        const bytes = text.length + 1
        this.rxPartial = ''
        this.rxLines.push({ text, bytes })
        this.rxUsed += bytes
        if (this.rxUsed > this.rxSize - 1) this.overflowed = true
      } else if (ch !== '\r') {
        this.rxPartial += ch
      }
    }
  }

  private override(code: number) {
    const o = this.ov
    const c = (v: number) => Math.max(10, Math.min(200, v))
    if (code === 0x90) o.feed = 100
    else if (code === 0x91) o.feed = c(o.feed + 10)
    else if (code === 0x92) o.feed = c(o.feed - 10)
    else if (code === 0x93) o.feed = c(o.feed + 1)
    else if (code === 0x94) o.feed = c(o.feed - 1)
    else if (code === 0x99) o.spindle = 100
    else if (code === 0x9a) o.spindle = c(o.spindle + 10)
    else if (code === 0x9b) o.spindle = c(o.spindle - 10)
    else if (code === 0x9c) o.spindle = c(o.spindle + 1)
    else if (code === 0x9d) o.spindle = c(o.spindle - 1)
  }

  private softReset() {
    const moving = this.current !== null && this.state !== 'Hold'
    this.planner = []
    this.current = null
    this.rxLines = []
    this.rxPartial = ''
    this.rxUsed = 0
    this.spindle = 'off'
    this.s = 0
    this.ov = { feed: 100, rapid: 100, spindle: 100 }
    this.state = moving ? 'Alarm' : 'Idle'
    this.send("\r\nGrbl 1.1h ['$' for help]\r\n")
    if (moving) this.send('ALARM:3\r\n')
  }

  private reportStatus() {
    const n = this.statusCount++
    const f = (v: number) => v.toFixed(3)
    let out = `<${this.state === 'Hold' ? 'Hold:0' : this.state}|MPos:${f(this.mx)},${f(this.my)},0.000|Bf:${this.plannerSize - this.planner.length},${Math.max(0, this.rxSize - this.rxUsed)}`
    out += `|FS:${Math.round(this.current ? this.current.feedMmMin : 0)},${this.laserPower()}`
    if (n % 10 === 0) out += `|WCO:${f(this.wco.x)},${f(this.wco.y)},0.000|Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}`
    out += '>\r\n'
    this.send(out)
  }

  private laserPower() {
    if (!this.current || !this.current.laser) return 0
    return Math.round((this.current.s * this.ov.spindle) / 100)
  }

  // ----- execution -----
  private tick() {
    const now = performance.now()
    let dt = ((now - this.lastTick) / 1000) * this.speed
    this.lastTick = now
    this.parseLines()
    if (this.state === 'Hold' || this.state === 'Alarm') return
    while (dt > 0) {
      if (!this.current) {
        this.current = this.planner.shift() ?? null
        if (!this.current) {
          if (this.state === 'Run' || this.state === 'Jog') this.state = 'Idle'
          break
        }
        this.current.x0 = this.mx
        this.current.y0 = this.my
        this.state = this.current.jog ? 'Jog' : 'Run'
        this.parseLines()
      }
      const b = this.current
      const use = Math.min(dt, b.remaining)
      const frac = b.duration > 0 ? use / b.duration : 1
      const fromX = this.mx
      const fromY = this.my
      if (b.dwell !== undefined && b.laser) this.maxLaserS = Math.max(this.maxLaserS, b.s)
      if (b.dwell === undefined) {
        this.mx += (b.x - b.x0) * frac
        this.my += (b.y - b.y0) * frac
        if (b.laser) this.maxLaserS = Math.max(this.maxLaserS, b.s)
        if (Math.hypot(this.mx - fromX, this.my - fromY) > 1e-9) {
          this.trace.push({ x0: fromX, y0: fromY, x1: this.mx, y1: this.my, s: b.laser ? b.s : 0, rapid: b.feedMmMin === this.rapidMmMin && !b.laser })
        }
      }
      b.remaining -= use
      dt -= use
      if (b.remaining <= 1e-9) {
        this.mx = b.dwell === undefined ? b.x : this.mx
        this.my = b.dwell === undefined ? b.y : this.my
        this.current = null
      }
    }
  }

  private parseLines() {
    while (this.rxLines.length) {
      const next = this.rxLines[0]
      const isMotion = /G0*[01](?!\d)|G4(?!\d)|\$J=|X-?\d|Y-?\d/i.test(next.text) && !/G10|G92/i.test(next.text)
      if (isMotion && this.planner.length >= this.plannerSize) return
      this.rxLines.shift()
      this.rxUsed -= next.bytes
      this.execLine(next.text)
    }
  }

  private fail(code: number) {
    this.send(`error:${code}\r\n`)
  }

  private execLine(raw: string) {
    const text = raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').replace(/\s+/g, '').toUpperCase()
    if (!text) return this.send('ok\r\n')
    for (const f of this.failures) if (f.re.test(text)) return this.fail(f.code)
    this.accepted.push(text)
    if (text.length > 80) return this.fail(11)
    if (text === '$$') {
      for (const [k, v] of Object.entries(this.settings)) this.send(`$${k}=${v}\r\n`)
      return this.send('ok\r\n')
    }
    let m = /^\$(\d+)=(.+)$/.exec(text)
    if (m) {
      this.settings[Number(m[1])] = m[2]
      return this.send('ok\r\n')
    }
    if (text === '$X') {
      this.state = 'Idle'
      this.send('[MSG:Caution: Unlocked]\r\n')
      return this.send('ok\r\n')
    }
    if (text === '$H') {
      this.planner = []
      this.mx = 0
      this.my = 0
      this.state = 'Idle'
      return this.send('ok\r\n')
    }
    if (this.state === 'Alarm') return this.fail(9)
    const jog = text.startsWith('$J=')
    const body = jog ? text.slice(3) : text
    if (text.startsWith('$')) return this.send('ok\r\n')

    const words: Record<string, number[]> = {}
    const re = /([A-Z])(-?\d*\.?\d+)/g
    let w: RegExpExecArray | null
    const consumed: string[] = []
    while ((w = re.exec(body))) {
      ;(words[w[1]] ??= []).push(Number(w[2]))
      consumed.push(w[0])
    }
    if (consumed.join('') !== body) return this.fail(2)
    const gs = words.G ?? []
    const ms = words.M ?? []
    for (const g of gs) {
      if (![0, 1, 4, 10, 17, 20, 21, 90, 91, 92, 94, 54].includes(g)) return this.fail(20)
    }
    if (words.F) this.feed = words.F[0]
    if (words.S) this.s = words.S[0]
    if (gs.includes(90)) this.relative = false
    if (gs.includes(91)) this.relative = true
    if (gs.includes(10) && words.L?.[0] === 2) {
      if (words.X) this.wco.x = words.X[0]
      if (words.Y) this.wco.y = words.Y[0]
      return this.send('ok\r\n')
    }
    if (gs.includes(10) && words.L?.[0] === 20) {
      if (words.X) this.wco.x = this.mx - words.X[0]
      if (words.Y) this.wco.y = this.my - words.Y[0]
      return this.send('ok\r\n')
    }
    if (gs.includes(92)) {
      if (words.X) this.wco.x = this.mx - words.X[0]
      if (words.Y) this.wco.y = this.my - words.Y[0]
      return this.send('ok\r\n')
    }
    for (const mm of ms) {
      if (mm === 3) this.spindle = 'M3'
      else if (mm === 4) this.spindle = 'M4'
      else if (mm === 5) this.spindle = 'off'
      else if (![8, 9].includes(mm)) return this.fail(20)
    }
    if (gs.includes(0)) this.motion = 0
    if (gs.includes(1)) this.motion = 1
    if (gs.includes(4)) {
      this.planner.push(this.block({ dwell: words.P?.[0] ?? 0 }))
      return this.send('ok\r\n')
    }
    if (words.X || words.Y) {
      if (!gs.includes(0) && !gs.includes(1) && jog === false && gs.length === 0 && ms.length === 0 && this.motion === 1 && this.feed <= 0) return this.fail(22)
      const tx = words.X ? (this.relative ? this.lastTargetX() + words.X[0] : words.X[0] + this.wco.x) : this.lastTargetX()
      const ty = words.Y ? (this.relative ? this.lastTargetY() + words.Y[0] : words.Y[0] + this.wco.y) : this.lastTargetY()
      this.planner.push(this.block({ x: tx, y: ty, jog }))
      if (this.state === 'Idle') this.state = jog ? 'Jog' : 'Run'
    }
    this.send('ok\r\n')
  }

  private tx = 0
  private ty = 0
  private lastTargetX() {
    const last = this.planner[this.planner.length - 1]
    return last && last.dwell === undefined ? last.x : this.current ? this.current.x : this.mx
  }
  private lastTargetY() {
    const last = this.planner[this.planner.length - 1]
    return last && last.dwell === undefined ? last.y : this.current ? this.current.y : this.my
  }

  private block(o: { x?: number; y?: number; dwell?: number; jog?: boolean }): Block {
    const x = o.x ?? this.lastTargetX()
    const y = o.y ?? this.lastTargetY()
    const sx = this.lastTargetX()
    const sy = this.lastTargetY()
    const rapid = this.motion === 0 && !o.jog
    const feedMmMin = rapid ? this.rapidMmMin : Math.max(1, this.feed) * (this.ov.feed / 100)
    const dist = Math.hypot(x - sx, y - sy)
    const duration = o.dwell !== undefined ? o.dwell : dist / (feedMmMin / 60)
    const laser =
      // GRBL laser mode: only G1/G2/G3 fire; G0 and jogs never do. Standing still (a dwell) fires only with M3
      // in G1 mode, because M4 scales power with speed and speed is zero.
      !rapid && !o.jog && o.dwell === undefined ? this.spindle === 'M4' || this.spindle === 'M3' : o.dwell !== undefined ? this.spindle === 'M3' && this.motion !== 0 : false
    return { x, y, x0: sx, y0: sy, feedMmMin, s: laser ? this.s : 0, laser: laser && this.s > 0, dwell: o.dwell, jog: o.jog, remaining: duration, duration }
  }
}
