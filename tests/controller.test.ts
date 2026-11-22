import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { MachineController, type EmberEvent } from '../src/main/controller'
import { SimulatorConnection } from '../src/core/connection/simulator'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 10000) {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await sleep(10)
  }
}
const job = () => {
  const l = ['G21 G90', 'M4 S0']
  for (let i = 0; i < 20; i++) l.push(`G0 X0 Y${i}`, `G1 X10 Y${i} S300 F6000`)
  l.push('M5 S0')
  return l
}

describe('MachineController', () => {
  it('runs a job from the PC against the simulator and reports events', async () => {
    const events: EmberEvent[] = []
    const c = new MachineController((e) => events.push(e))
    await c.connect({ kind: 'simulator' })
    await until(() => events.some((e) => e.type === 'status' && e.status.state === 'Idle'))
    await sleep(100)
    await c.startJob(job(), 'test', 'pc')
    await until(() => events.some((e) => e.type === 'jobEnd'))
    expect(events.find((e) => e.type === 'jobEnd')).toMatchObject({ result: 'done', where: 'pc' })
    await c.disconnect()
  })

  it('refuses manual commands while a job runs', async () => {
    const events: EmberEvent[] = []
    const c = new MachineController((e) => events.push(e))
    await c.connect({ kind: 'simulator' })
    await until(() => events.some((e) => e.type === 'status' && e.status.state === 'Idle'))
    await sleep(100)
    await c.startJob(job(), 'test', 'pc')
    expect(() => c.send('G0 X5')).toThrow(/job is running/)
    c.emergencyStop()
    await c.disconnect()
  })
})

/** A stand-in for the ESP32 firmware: same HTTP + WebSocket protocol, backed by the GRBL simulator. */
function mockEsp32() {
  const sim = new SimulatorConnection({ speedFactor: 20 })
  const files = new Map<string, string>()
  let jobState: any = { state: 'idle', line: 0, total: 0, elapsedMs: 0 }
  let timer: ReturnType<typeof setInterval> | undefined
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    const body = await new Promise<string>((r) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => r(b))
    })
    const json = (o: unknown, code = 200) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)))
    if (url.pathname === '/api/files' && req.method === 'GET') return json({ files: [...files].map(([name, d]) => ({ name, size: d.length })) })
    if (url.pathname === '/api/files' && req.method === 'DELETE') return files.delete(url.searchParams.get('name')!), json({})
    if (url.pathname === '/api/upload') return files.set(url.searchParams.get('name')!, body), json({ ok: true })
    if (url.pathname === '/api/job' && req.method === 'GET') return json(jobState)
    if (url.pathname === '/api/job/start') {
      const name = JSON.parse(body).name
      const lines = files.get(name)!.split('\n').filter(Boolean)
      let i = 0
      const t0 = Date.now()
      jobState = { state: 'running', file: name, line: 0, total: lines.length, elapsedMs: 0 }
      // the device feeds its own simulated controller locally
      timer = setInterval(() => {
        for (let k = 0; k < 4 && i < lines.length; k++) sim.write(lines[i++] + '\n')
        jobState = { ...jobState, line: i, elapsedMs: Date.now() - t0, state: i >= lines.length && !sim.busy ? 'done' : 'running' }
        if (jobState.state === 'done') clearInterval(timer)
      }, 20)
      return json({})
    }
    if (url.pathname === '/api/job/stop') return clearInterval(timer), (jobState = { ...jobState, state: 'aborted' }), json({})
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    const off = sim.onData((d) => ws.send(d))
    ws.on('message', (m) => sim.write((m as Buffer).toString('latin1')))
    ws.on('close', off)
  })
  return new Promise<{ port: number; sim: SimulatorConnection; files: Map<string, string>; close: () => void }>((resolve) => {
    void sim.open().then(() =>
      server.listen(0, () => resolve({ port: (server.address() as any).port, sim, files, close: () => (clearInterval(timer), wss.close(), server.close(), sim.close()) })),
    )
  })
}

describe('ESP32 bridge protocol', () => {
  it('uploads a job, runs it on the device, and reports progress to completion', async () => {
    const dev = await mockEsp32()
    const events: EmberEvent[] = []
    const c = new MachineController((e) => events.push(e))
    await c.connect({ kind: 'esp32', host: '127.0.0.1', port: dev.port })
    await until(() => events.some((e) => e.type === 'status' && e.status.state === 'Idle'))
    await sleep(100)
    expect(events.find((e) => e.type === 'connection')).toMatchObject({ deviceJobs: true })
    await c.startJob(job(), 'my job', 'device')
    expect(dev.files.has('my_job.nc')).toBe(true)
    await until(() => events.some((e) => e.type === 'jobEnd'))
    const end = events.find((e) => e.type === 'jobEnd') as any
    expect(end).toMatchObject({ result: 'done', where: 'device' })
    expect(events.some((e) => e.type === 'job' && e.where === 'device' && e.progress.total > 0)).toBe(true)
    expect(await c.deviceFiles()).toEqual([expect.objectContaining({ name: 'my_job.nc' })])
    await c.disconnect()
    dev.close()
  })
})
