import { GrblClient, type JobProgress } from '../core/grbl/client'
import type { Connection, DeviceJobState } from '../core/connection/types'
import { SimulatorConnection } from '../core/connection/simulator'
import { Esp32Connection, SerialConnection, TcpConnection, WebSocketConnection } from '../core/connection/network'

export type ConnectRequest =
  | { kind: 'serial'; path: string; baud: number }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'websocket'; url: string }
  | { kind: 'esp32'; host: string; port?: number }
  | { kind: 'simulator' }

export type EmberEvent =
  | { type: 'connection'; connected: boolean; label?: string; kind?: string; error?: string; deviceJobs?: boolean }
  | { type: 'status'; status: GrblClient['status'] }
  | { type: 'line'; dir: 'tx' | 'rx'; text: string }
  | { type: 'alarm'; code: number; message: string }
  | { type: 'error'; code: number; message: string; line?: string; jobLine?: number }
  | { type: 'job'; progress: JobProgress; where: 'pc' | 'device' }
  | { type: 'jobEnd'; result: string; reason?: string; where: 'pc' | 'device' }
  | { type: 'settings'; settings: Record<number, string> }
  | { type: 'welcome'; version: string }

/**
 * Owns the one active machine connection and turns GRBL client events into UI events.
 * Also runs "device jobs": uploads G-code to the ESP32 and follows its progress.
 */
export class MachineController {
  private client?: GrblClient
  private conn?: Connection
  private deviceJobPoll?: ReturnType<typeof setInterval>
  private deviceJobActive = false
  private deviceJobName = ''

  constructor(private emit: (e: EmberEvent) => void) {}

  /** True while the laser is moving, burning, paused or running a job: nothing may restart the program then. */
  get busy() {
    if (!this.client) return false
    const st = this.client.status.state
    return this.client.jobActive || this.deviceJobActive || !(st === 'Idle' || st === 'Disconnected' || st === 'Alarm' || st === 'Sleep')
  }

  get connected() {
    return !!this.client && this.client.status.state !== 'Disconnected'
  }

  private need(): GrblClient {
    if (!this.client) throw new Error('Not connected to a machine.')
    return this.client
  }

  async connect(req: ConnectRequest) {
    if (this.client) await this.disconnect()
    let conn: Connection
    switch (req.kind) {
      case 'serial':
        conn = new SerialConnection({ path: req.path, baud: req.baud })
        break
      case 'tcp':
        conn = new TcpConnection(req.host, req.port)
        break
      case 'websocket':
        conn = new WebSocketConnection(req.url)
        break
      case 'esp32':
        conn = new Esp32Connection(req.host, req.port ?? 80)
        break
      case 'simulator':
        conn = new SimulatorConnection({ speedFactor: 8 })
        break
    }
    const client = new GrblClient(conn, { pollMs: 200, onJobError: 'abort' })
    client.on('status', (status) => this.emit({ type: 'status', status }))
    client.on('line', (l) => this.emit({ type: 'line', ...l }))
    client.on('alarm', (a) => this.emit({ type: 'alarm', ...a }))
    client.on('error', (e) => this.emit({ type: 'error', ...e }))
    client.on('job', (progress) => this.emit({ type: 'job', progress, where: 'pc' }))
    client.on('jobEnd', (e) => this.emit({ type: 'jobEnd', result: e.result, reason: e.reason, where: 'pc' }))
    client.on('settings', (settings) => this.emit({ type: 'settings', settings }))
    client.on('welcome', (w) => {
      this.emit({ type: 'welcome', version: w.version })
      // Boards that reboot when the port opens print the banner late; ask for $$ again once it is up.
      setTimeout(() => {
        try {
          if (this.client === client && !client.jobActive) client.requestSettings()
        } catch {
          /* ignore */
        }
      }, 400)
    })
    client.on('connection', (c) => {
      if (!c.connected) this.stopDevicePoll()
      this.emit({ type: 'connection', connected: c.connected, error: c.error, label: conn.label, kind: conn.kind, deviceJobs: !!conn.deviceJobs })
    })
    this.client = client
    this.conn = conn
    await client.connect()
    this.emit({ type: 'connection', connected: true, label: conn.label, kind: conn.kind, deviceJobs: !!conn.deviceJobs })
    // Settings tell us whether laser mode ($32) is on and what $30 is.
    setTimeout(() => {
      try {
        if (!client.jobActive && client.status.state !== 'Disconnected') client.requestSettings()
      } catch {
        /* ignore */
      }
    }, 1500)
  }

  async disconnect() {
    this.stopDevicePoll()
    const c = this.client
    this.client = undefined
    this.conn = undefined
    if (c) await c.disconnect()
  }

  private guard() {
    if (this.deviceJobActive) throw new Error('The ESP32 is running a job. Pause or stop it first.')
  }

  send(text: string) {
    this.guard()
    this.need().send(text)
  }
  jog(d: { x?: number; y?: number; z?: number }, feed: number) {
    this.guard()
    this.need().jog(d, feed)
  }
  jogCancel() {
    this.need().jogCancel()
  }
  home() {
    this.guard()
    this.need().home()
  }
  unlock() {
    this.guard()
    this.need().unlock()
  }
  zero() {
    this.guard()
    this.need().setWorkZero()
  }
  goto(x: number, y: number) {
    this.guard()
    this.need().goto(x, y)
  }
  reset() {
    this.need().softReset()
  }
  override(kind: 'feed' | 'spindle' | 'rapid', pct: number) {
    this.need().setOverride(kind, pct)
  }
  async pulse(powerPct: number, maxS: number) {
    this.guard()
    await this.need().pulseLaser(powerPct, maxS)
  }
  requestSettings() {
    this.guard()
    this.need().requestSettings()
  }
  writeSetting(id: number, value: string) {
    this.guard()
    if (!/^[\d.-]+$/.test(value)) throw new Error('Setting values must be numbers.')
    this.need().send(`$${id}=${value}`)
    setTimeout(() => this.client?.requestSettings(), 300)
  }

  // ---- jobs ----

  startJob(lines: string[], name: string, where: 'pc' | 'device') {
    const c = this.need()
    if (where === 'pc') {
      this.guard()
      c.startJob(lines, name)
      return Promise.resolve()
    }
    return this.startDeviceJob(lines, name)
  }

  private async startDeviceJob(lines: string[], name: string) {
    const dj = this.conn?.deviceJobs
    if (!dj) throw new Error('This connection cannot run jobs on the device.')
    if (this.client!.jobActive) throw new Error('A job is already running.')
    const st = this.client!.status.state
    if (st !== 'Idle') throw new Error(`Machine is ${st}; it must be Idle to start a job.`)
    const clean = GrblClient.prepareJob(lines)
    this.deviceJobName = name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'job'
    if (!this.deviceJobName.endsWith('.nc')) this.deviceJobName += '.nc'
    await dj.upload(this.deviceJobName, clean.join('\n') + '\n')
    await dj.start(this.deviceJobName)
    this.deviceJobActive = true
    this.pollDevice()
  }

  private pollDevice() {
    this.stopDevicePoll()
    const dj = this.conn?.deviceJobs
    if (!dj) return
    const started = Date.now()
    const tick = async () => {
      try {
        const s: DeviceJobState = await dj.status()
        const running = s.state === 'running' || s.state === 'paused'
        const progress: JobProgress = {
          state: s.state === 'paused' ? 'paused' : running ? 'running' : 'idle',
          name: s.file ?? this.deviceJobName,
          total: s.total,
          sent: s.line,
          acked: s.line,
          startedAt: started,
          elapsedMs: s.elapsedMs,
          etaMs: s.line > 20 && s.total ? Math.round((s.elapsedMs / s.line) * (s.total - s.line)) : undefined,
        }
        this.emit({ type: 'job', progress, where: 'device' })
        if (!running) {
          this.deviceJobActive = false
          this.stopDevicePoll()
          const result = s.state === 'done' ? 'done' : s.state === 'error' ? 'error' : 'aborted'
          this.emit({ type: 'jobEnd', result, reason: s.error, where: 'device' })
        }
      } catch (e) {
        // Keep polling through brief Wi-Fi hiccups; the job runs on the device regardless.
        this.emit({ type: 'line', dir: 'rx', text: `[ember] device status poll failed: ${(e as Error).message}` })
      }
    }
    this.deviceJobPoll = setInterval(tick, 700)
    void tick()
  }

  private stopDevicePoll() {
    if (this.deviceJobPoll) clearInterval(this.deviceJobPoll)
    this.deviceJobPoll = undefined
  }

  /** Re-attach to a job that is already running on the ESP32 (for example after reopening the app). */
  async attachDeviceJob() {
    const dj = this.conn?.deviceJobs
    if (!dj) return
    const s = await dj.status()
    if (s.state === 'running' || s.state === 'paused') {
      this.deviceJobActive = true
      this.deviceJobName = s.file ?? 'job'
      this.pollDevice()
    }
  }

  pause() {
    if (this.deviceJobActive) return this.conn!.deviceJobs!.pause()
    this.need().pause()
  }
  resume() {
    if (this.deviceJobActive) return this.conn!.deviceJobs!.resume()
    this.need().resume()
  }
  async stop() {
    if (this.deviceJobActive) {
      await this.conn!.deviceJobs!.stop()
      return
    }
    this.need().stop()
  }
  emergencyStop() {
    // Always send the reset byte straight to the controller as well, whatever else is going on.
    this.client?.emergencyStop()
    if (this.deviceJobActive) void this.conn?.deviceJobs?.stop().catch(() => undefined)
  }

  deviceFiles() {
    const dj = this.conn?.deviceJobs
    if (!dj) throw new Error('No ESP32 connected.')
    return dj.list()
  }
  async deviceRemove(name: string) {
    await this.conn?.deviceJobs?.remove(name)
  }
  async deviceRun(name: string) {
    const dj = this.conn?.deviceJobs
    if (!dj) throw new Error('No ESP32 connected.')
    if (this.client?.status.state !== 'Idle') throw new Error('Machine must be Idle.')
    this.deviceJobName = name
    await dj.start(name)
    this.deviceJobActive = true
    this.pollDevice()
  }
}
