/** Anything that can carry GRBL bytes to and from a controller. */
export interface Connection {
  readonly kind: 'serial' | 'tcp' | 'websocket' | 'esp32' | 'simulator'
  readonly label: string
  readonly isOpen: boolean
  open(): Promise<void>
  close(): Promise<void>
  /** Write raw text. Realtime command bytes are written as single characters. */
  write(data: string): void
  onData(cb: (chunk: string) => void): () => void
  onClose(cb: (err?: Error) => void): () => void
  /** Present on connections whose far end can run a job by itself (the ESP32 bridge). */
  deviceJobs?: DeviceJobs
}

export interface DeviceJobFile {
  name: string
  size: number
}

export interface DeviceJobState {
  state: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'aborted'
  file?: string
  line: number
  total: number
  elapsedMs: number
  error?: string
}

/** Job storage and execution that lives on the device. The PC only uploads, starts, and watches. */
export interface DeviceJobs {
  list(): Promise<DeviceJobFile[]>
  upload(name: string, gcode: string): Promise<void>
  remove(name: string): Promise<void>
  start(name: string): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  status(): Promise<DeviceJobState>
}

export class Emitter1<T> {
  private subs = new Set<(v: T) => void>()
  on(cb: (v: T) => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }
  emit(v: T) {
    for (const s of [...this.subs]) s(v)
  }
  clear() {
    this.subs.clear()
  }
}
