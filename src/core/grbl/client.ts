import type { Connection } from '../connection/types'
import {
  cleanGcodeLine,
  parseGrblLine,
  RT,
  type MachineState,
  type MachineStatus,
  type Vec3,
} from './protocol'

export interface ClientOptions {
  /** GRBL's serial RX buffer is 128 bytes (127 usable). We stay a little under. */
  rxBufferSize?: number
  /** Status poll interval in ms. 0 disables polling. */
  pollMs?: number
  /** What to do when GRBL rejects a line while a job is streaming. */
  onJobError?: 'abort' | 'pause'
}

export interface JobProgress {
  state: 'idle' | 'running' | 'paused' | 'finishing'
  name?: string
  total: number
  sent: number
  acked: number
  startedAt: number
  elapsedMs: number
  etaMs?: number
}

export type JobResult = 'done' | 'aborted' | 'error' | 'disconnected'

export interface ClientEvents {
  status: MachineStatus
  line: { dir: 'tx' | 'rx'; text: string }
  alarm: { code: number; message: string }
  error: { code: number; message: string; line?: string; jobLine?: number }
  job: JobProgress
  jobEnd: { result: JobResult; reason?: string; progress: JobProgress }
  settings: Record<number, string>
  welcome: { version: string }
  connection: { connected: boolean; error?: string }
}

type Listener<K extends keyof ClientEvents> = (v: ClientEvents[K]) => void

interface Pending {
  len: number
  job: boolean
  text: string
  jobIndex: number
}

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 })

export class GrblClient {
  status: MachineStatus = {
    state: 'Disconnected',
    mpos: zero(),
    wpos: zero(),
    wco: zero(),
    feed: 0,
    spindle: 0,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
  }
  settings: Record<number, string> = {}

  private listeners: Partial<Record<keyof ClientEvents, Set<(v: never) => void>>> = {}
  private rxBuf = ''
  private pending: Pending[] = []
  private manual: string[] = []
  private inFlight = 0
  private rxSize: number
  private pollTimer?: ReturnType<typeof setInterval>
  private offData?: () => void
  private offClose?: () => void

  // job state
  private job: string[] = []
  private jobName?: string
  private jobNext = 0
  private jobAcked = 0
  private jobState: JobProgress['state'] = 'idle'
  private resumeTo: 'running' | 'finishing' = 'running'
  private jobStart = 0
  private jobEndedPaused = false
  private statusSeq = 0
  private finalAckSeq = -1
  private lastProgressEmit = 0

  constructor(
    readonly conn: Connection,
    private opts: ClientOptions = {},
  ) {
    this.rxSize = opts.rxBufferSize ?? 120
  }

  on<K extends keyof ClientEvents>(ev: K, cb: Listener<K>): () => void {
    const set = (this.listeners[ev] ??= new Set()) as Set<Listener<K>>
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }
  private emit<K extends keyof ClientEvents>(ev: K, v: ClientEvents[K]) {
    const set = this.listeners[ev] as Set<Listener<K>> | undefined
    if (set) for (const cb of [...set]) cb(v)
  }

  async connect(): Promise<void> {
    await this.conn.open()
    this.offData = this.conn.onData((c) => this.onChunk(c))
    this.offClose = this.conn.onClose((err) => this.onClosed(err))
    this.status = { ...this.status, state: 'Unknown' }
    this.emit('connection', { connected: true })
    // Give the board a moment to print its welcome banner, then ask where it is.
    this.rawWrite(RT.STATUS)
    const ms = this.opts.pollMs ?? 200
    if (ms > 0) this.pollTimer = setInterval(() => this.rawWrite(RT.STATUS), ms)
  }

  async disconnect(): Promise<void> {
    if (this.jobState !== 'idle') this.finishJob('aborted', 'Disconnected')
    this.stopPolling()
    this.offData?.()
    this.offClose?.()
    await this.conn.close()
    this.setState('Disconnected')
    this.emit('connection', { connected: false })
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private onClosed(err?: Error) {
    this.stopPolling()
    if (this.jobState !== 'idle') this.finishJob('disconnected', 'Connection lost')
    this.pending = []
    this.manual = []
    this.inFlight = 0
    this.setState('Disconnected')
    this.emit('connection', { connected: false, error: err?.message })
  }

  private setState(state: MachineState) {
    this.status = { ...this.status, state }
    this.emit('status', this.status)
  }

  private rawWrite(s: string) {
    if (!this.conn.isOpen) return
    this.conn.write(s)
  }

  /** Send a realtime byte (never buffered, never counted). */
  realtime(byte: string) {
    this.rawWrite(byte)
  }

  // ---------- receiving ----------

  private onChunk(chunk: string) {
    this.rxBuf += chunk
    let i: number
    while ((i = this.rxBuf.search(/\r?\n/)) >= 0) {
      const line = this.rxBuf.slice(0, i)
      this.rxBuf = this.rxBuf.slice(this.rxBuf[i] === '\r' ? i + 2 : i + 1)
      this.onLine(line)
    }
  }

  private onLine(line: string) {
    const ev = parseGrblLine(line)
    if (!ev) return
    // Status lines arrive several times a second; keep them out of the console log stream.
    if (ev.type !== 'status') this.emit('line', { dir: 'rx', text: line.trim() })
    switch (ev.type) {
      case 'status': {
        const prev = this.status
        const s = ev.status
        const next: MachineStatus = {
          ...prev,
          ...s,
          wco: s.wco ?? prev.wco,
          mpos: s.mpos ?? prev.mpos,
          wpos: s.wpos ?? prev.wpos,
          overrides: s.overrides ?? prev.overrides,
        }
        if (s.mpos && !s.wpos) next.wpos = sub(s.mpos, next.wco)
        if (s.wpos && !s.mpos) next.mpos = add(s.wpos, next.wco)
        this.status = next
        this.statusSeq++
        this.emit('status', next)
        this.checkJobFinished()
        break
      }
      case 'ok':
        this.onAck(null)
        break
      case 'error':
        this.onAck(ev)
        break
      case 'alarm':
        this.emit('alarm', { code: ev.code, message: ev.message })
        // GRBL drops everything queued when it alarms. We must too.
        this.pending = []
        this.manual = []
        this.inFlight = 0
        if (this.jobState !== 'idle') this.finishJob('error', `Alarm ${ev.code}: ${ev.message}`)
        break
      case 'setting':
        this.settings = { ...this.settings, [ev.id]: ev.value }
        this.emit('settings', this.settings)
        break
      case 'welcome':
        // A soft reset (or power-up) wipes GRBL's buffers.
        this.pending = []
        this.inFlight = 0
        this.manual = []
        if (this.jobState !== 'idle') this.finishJob('aborted', 'Controller reset')
        this.emit('welcome', { version: ev.version })
        break
    }
  }

  private onAck(err: { code: number; message: string } | null) {
    const p = this.pending.shift()
    if (!p) return
    this.inFlight -= p.len
    if (p.job) this.jobAcked++
    if (err) {
      this.emit('error', { code: err.code, message: err.message, line: p.text, jobLine: p.job ? p.jobIndex + 1 : undefined })
      if (p.job && this.jobState !== 'idle') {
        if (this.opts.onJobError === 'pause') {
          this.pause()
        } else {
          this.abortJob(`Line ${p.jobIndex + 1} rejected: ${err.message} (${p.text})`, 'error')
          return
        }
      }
    }
    this.emitProgress()
    this.pump()
    this.checkJobFinished()
  }

  // ---------- sending ----------

  private pump() {
    if (!this.conn.isOpen) return
    // Manual lines first. They only exist when no job is running (send() enforces that).
    while (this.manual.length) {
      const text = this.manual[0]
      const len = text.length + 1
      if (this.inFlight + len > this.rxSize) return
      this.manual.shift()
      this.writeLine(text, len, false, -1)
    }
    if (this.jobState !== 'running') return
    while (this.jobNext < this.job.length) {
      const text = this.job[this.jobNext]
      const len = text.length + 1
      if (this.inFlight + len > this.rxSize) return
      this.writeLine(text, len, true, this.jobNext)
      this.jobNext++
    }
  }

  private writeLine(text: string, len: number, job: boolean, jobIndex: number) {
    this.pending.push({ len, job, text, jobIndex })
    this.inFlight += len
    this.conn.write(text + '\n')
    if (!job || this.jobNext % 50 === 0) this.emit('line', { dir: 'tx', text })
  }

  /** Send one command. Rejected while a job is running so manual moves can't collide with it. */
  send(command: string) {
    if (this.jobState !== 'idle') throw new Error('Cannot send commands while a job is running. Pause or stop it first.')
    if (this.status.state === 'Disconnected') throw new Error('Not connected.')
    const text = command.trim()
    if (!text) return
    if (text.length > 120) throw new Error('Command too long.')
    this.manual.push(text)
    this.pump()
  }

  requestSettings() {
    this.send('$$')
  }

  jog(delta: { x?: number; y?: number; z?: number }, feedMmMin: number, relative = true) {
    const w = (k: string, v?: number) => (v === undefined ? '' : `${k}${+v.toFixed(3)}`)
    this.send(`$J=${relative ? 'G91' : 'G90'} G21 ${w('X', delta.x)} ${w('Y', delta.y)} ${w('Z', delta.z)} F${Math.round(feedMmMin)}`.replace(/\s+/g, ' '))
  }
  jogCancel() {
    this.realtime(RT.JOG_CANCEL)
  }
  home() {
    this.send('$H')
  }
  unlock() {
    this.send('$X')
  }
  /** Make the current head position work zero for X and Y. */
  setWorkZero() {
    this.send('G10 L20 P1 X0 Y0')
  }
  goto(x: number, y: number, feedMmMin = 6000) {
    this.send(`G90 G0 X${+x.toFixed(3)} Y${+y.toFixed(3)}`)
    void feedMmMin
  }
  softReset() {
    this.rawWrite(RT.RESET)
  }

  /**
   * Fire the laser briefly at low power for aiming. A pulse, never a latch, so a lost connection
   * can't leave the laser on.
   */
  async pulseLaser(powerPct: number, maxS: number, ms = 150) {
    const s = Math.round((Math.max(0, Math.min(10, powerPct)) / 100) * maxS)
    this.send(`M3 S${s}`)
    this.send(`G4 P${(Math.min(ms, 500) / 1000).toFixed(2)}`)
    this.send('M5 S0')
  }

  /** Set an override to a target percentage using GRBL's +10/+1 steps. */
  setOverride(kind: 'feed' | 'spindle' | 'rapid', target: number) {
    if (kind === 'rapid') {
      this.realtime(target >= 100 ? RT.RAPID_100 : target >= 50 ? RT.RAPID_50 : RT.RAPID_25)
      return
    }
    const cur = this.status.overrides[kind]
    const clamped = Math.max(10, Math.min(200, Math.round(target)))
    let d = clamped - cur
    const [p10, m10, p1, m1] =
      kind === 'feed'
        ? [RT.FEED_PLUS10, RT.FEED_MINUS10, RT.FEED_PLUS1, RT.FEED_MINUS1]
        : [RT.SPINDLE_PLUS10, RT.SPINDLE_MINUS10, RT.SPINDLE_PLUS1, RT.SPINDLE_MINUS1]
    while (Math.abs(d) >= 10) {
      this.realtime(d > 0 ? p10 : m10)
      d += d > 0 ? -10 : 10
    }
    while (d !== 0) {
      this.realtime(d > 0 ? p1 : m1)
      d += d > 0 ? -1 : 1
    }
  }

  // ---------- jobs ----------

  get jobActive() {
    return this.jobState !== 'idle'
  }

  /** Validates, cleans and returns the lines a job would send. Throws on lines GRBL would reject. */
  static prepareJob(lines: string[]): string[] {
    const out: string[] = []
    lines.forEach((l, i) => {
      const c = cleanGcodeLine(l)
      if (!c) return
      if (c.length > 80) throw new Error(`G-code line ${i + 1} is ${c.length} characters; GRBL's limit is 80.`)
      out.push(c)
    })
    return out
  }

  startJob(lines: string[], name?: string) {
    if (this.jobState !== 'idle') throw new Error('A job is already running.')
    const st = this.status.state
    if (st === 'Disconnected') throw new Error('Not connected.')
    if (st === 'Alarm') throw new Error('Machine is in alarm. Unlock or home it first.')
    if (st !== 'Idle' && st !== 'Unknown') throw new Error(`Machine is ${st}; it must be Idle to start a job.`)
    this.job = GrblClient.prepareJob(lines)
    if (!this.job.length) throw new Error('Job is empty.')
    this.jobName = name
    this.jobNext = 0
    this.jobAcked = 0
    this.jobStart = Date.now()
    this.jobState = 'running'
    this.jobEndedPaused = false
    this.finalAckSeq = -1
    this.emitProgress(true)
    this.pump()
  }

  pause() {
    if (this.jobState !== 'running' && this.jobState !== 'finishing') return
    this.resumeTo = this.jobState
    this.jobState = 'paused'
    this.rawWrite(RT.HOLD)
    this.emitProgress(true)
  }

  resume() {
    if (this.jobState !== 'paused') return
    this.jobState = this.resumeTo
    this.rawWrite(RT.RESUME)
    this.emitProgress(true)
    this.pump()
  }

  /** Stop the job: feed hold (laser off), then reset to flush GRBL's planner. Position is kept when stopped in time. */
  stop(reason = 'Stopped by user') {
    this.abortJob(reason, 'aborted')
  }

  /** Immediate reset with no deceleration. Use for the on-screen emergency stop. */
  emergencyStop() {
    this.rawWrite(RT.RESET)
    this.pending = []
    this.manual = []
    this.inFlight = 0
    if (this.jobState !== 'idle') this.finishJob('aborted', 'Emergency stop')
  }

  private abortJob(reason: string, result: JobResult) {
    this.rawWrite(RT.HOLD)
    // Let the hold take effect, then flush with a soft reset.
    setTimeout(() => this.rawWrite(RT.RESET), 120)
    this.pending = []
    this.manual = []
    this.inFlight = 0
    this.finishJob(result, reason)
  }

  private finishJob(result: JobResult, reason?: string) {
    if (this.jobState === 'idle') return
    const progress = this.progress()
    this.jobState = 'idle'
    this.job = []
    this.emit('jobEnd', { result, reason, progress })
    this.emit('job', { ...progress, state: 'idle' })
  }

  private checkJobFinished() {
    if (this.jobState !== 'running' && this.jobState !== 'finishing') return
    if (this.jobAcked >= this.job.length && this.pending.length === 0) {
      // Everything is queued in GRBL; wait until it has actually finished moving. A status report that
      // arrived before the last ack can be stale, so only trust an Idle report that came after it.
      if (this.finalAckSeq < 0) this.finalAckSeq = this.statusSeq
      if (this.status.state === 'Idle' && this.statusSeq > this.finalAckSeq) this.finishJob('done')
      else if (this.jobState === 'running') {
        this.jobState = 'finishing'
        this.emitProgress(true)
      }
    }
  }

  progress(): JobProgress {
    const elapsed = this.jobState === 'idle' ? 0 : Date.now() - this.jobStart
    const frac = this.job.length ? this.jobAcked / this.job.length : 0
    return {
      state: this.jobState,
      name: this.jobName,
      total: this.job.length,
      sent: this.jobNext,
      acked: this.jobAcked,
      startedAt: this.jobStart,
      elapsedMs: elapsed,
      etaMs: frac > 0.02 ? Math.round(elapsed / frac - elapsed) : undefined,
    }
  }

  private emitProgress(force = false) {
    const now = Date.now()
    if (!force && now - this.lastProgressEmit < 100) return
    this.lastProgressEmit = now
    this.emit('job', this.progress())
  }
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
