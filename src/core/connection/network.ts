// Real transports. Node-only (used from the Electron main process).
import type { Connection, DeviceJobFile, DeviceJobs, DeviceJobState } from './types'
import { Emitter1 } from './types'

abstract class Base implements Connection {
  abstract readonly kind: Connection['kind']
  abstract readonly label: string
  isOpen = false
  protected data = new Emitter1<string>()
  protected closeEv = new Emitter1<Error | undefined>()
  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract write(data: string): void
  onData(cb: (c: string) => void) {
    return this.data.on(cb)
  }
  onClose(cb: (e?: Error) => void) {
    return this.closeEv.on(cb)
  }
}

export interface SerialOptions {
  path: string
  baud: number
}

export interface PortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
  friendlyName?: string
}

export async function listSerialPorts(): Promise<PortInfo[]> {
  const { SerialPort } = await import('serialport')
  const ports = await SerialPort.list()
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    vendorId: p.vendorId,
    productId: p.productId,
    friendlyName: (p as { friendlyName?: string }).friendlyName,
  }))
}

export class SerialConnection extends Base {
  readonly kind = 'serial' as const
  get label() {
    return `${this.opts.path} @ ${this.opts.baud}`
  }
  private port?: import('serialport').SerialPort
  constructor(private opts: SerialOptions) {
    super()
  }
  async open() {
    const { SerialPort } = await import('serialport')
    await new Promise<void>((resolve, reject) => {
      this.port = new SerialPort({ path: this.opts.path, baudRate: this.opts.baud, autoOpen: false })
      this.port.open((err) => (err ? reject(err) : resolve()))
    })
    this.isOpen = true
    this.port!.on('data', (b: Buffer) => this.data.emit(b.toString('latin1')))
    this.port!.on('close', () => {
      if (this.isOpen) {
        this.isOpen = false
        this.closeEv.emit(new Error('Serial port closed'))
      }
    })
    this.port!.on('error', (e: Error) => {
      this.isOpen = false
      this.closeEv.emit(e)
    })
  }
  async close() {
    const p = this.port
    this.isOpen = false
    if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()))
  }
  write(data: string) {
    this.port?.write(Buffer.from(data, 'latin1'))
  }
}

export class TcpConnection extends Base {
  readonly kind = 'tcp' as const
  get label() {
    return `tcp://${this.host}:${this.port}`
  }
  private sock?: import('node:net').Socket
  constructor(
    private host: string,
    private port: number,
  ) {
    super()
  }
  async open() {
    const net = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port })
      s.setNoDelay(true)
      s.once('connect', () => resolve())
      s.once('error', reject)
      this.sock = s
    })
    this.isOpen = true
    this.sock!.on('data', (b) => this.data.emit(b.toString('latin1')))
    this.sock!.on('close', () => {
      if (this.isOpen) {
        this.isOpen = false
        this.closeEv.emit(new Error('Connection closed'))
      }
    })
    this.sock!.on('error', (e) => {
      this.isOpen = false
      this.closeEv.emit(e)
    })
  }
  async close() {
    this.isOpen = false
    this.sock?.destroy()
  }
  write(data: string) {
    this.sock?.write(Buffer.from(data, 'latin1'))
  }
}

/** GRBL over WebSocket text frames (FluidNC, grbl_esp32, and our own bridge). */
export class WebSocketConnection extends Base {
  readonly kind: 'websocket' | 'esp32' = 'websocket'
  get label() {
    return this.url
  }
  protected ws?: import('ws').WebSocket
  constructor(protected url: string) {
    super()
  }
  async open() {
    const { WebSocket } = await import('ws')
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 5000 })
      this.ws = ws
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    this.isOpen = true
    this.ws!.on('message', (d, isBinary) => {
      this.data.emit(isBinary ? Buffer.from(d as Buffer).toString('latin1') : d.toString())
    })
    this.ws!.on('close', () => {
      if (this.isOpen) {
        this.isOpen = false
        this.closeEv.emit(new Error('WebSocket closed'))
      }
    })
    this.ws!.on('error', (e) => {
      this.isOpen = false
      this.closeEv.emit(e)
    })
  }
  async close() {
    this.isOpen = false
    this.ws?.close()
  }
  write(data: string) {
    if (this.ws?.readyState === 1) this.ws.send(Buffer.from(data, 'latin1'), { binary: true })
  }
}

/**
 * The Ember ESP32 bridge. Raw GRBL passes through the WebSocket on /ws; jobs are uploaded over HTTP
 * and run by the ESP32 itself, so closing the laptop does not stop a burn.
 * See firmware/README.md for the protocol.
 */
export class Esp32Connection extends WebSocketConnection implements Connection {
  override readonly kind = 'esp32' as const
  readonly deviceJobs: DeviceJobs
  private base: string
  constructor(host: string, port = 80) {
    super(`ws://${host}:${port}/ws`)
    this.base = `http://${host}:${port}`
    const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text().catch(() => '')}`)
      const t = await res.text()
      return (t ? JSON.parse(t) : undefined) as T
    }
    const post = (path: string, body?: unknown) =>
      j<void>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    this.deviceJobs = {
      list: async () => (await j<{ files: DeviceJobFile[] }>('/api/files')).files,
      upload: async (name, gcode) => {
        const res = await fetch(`${this.base}/api/upload?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: gcode,
          signal: AbortSignal.timeout(10 * 60_000),
        })
        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text().catch(() => '')}`)
      },
      remove: (name) => j<void>(`/api/files?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
      start: (name) => post('/api/job/start', { name }),
      pause: () => post('/api/job/pause'),
      resume: () => post('/api/job/resume'),
      stop: () => post('/api/job/stop'),
      status: () => j<DeviceJobState>('/api/job'),
    }
  }
}
