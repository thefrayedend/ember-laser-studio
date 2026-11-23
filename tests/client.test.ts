import { describe, expect, it } from 'vitest'
import { GrblClient, type JobResult } from '../src/core/grbl/client'
import { SimulatorConnection } from '../src/core/connection/simulator'
import { generate } from '../src/core/gcode/generate'
import { FALCON2_22W, defaultLayer } from '../src/core/types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 8000) {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await sleep(5)
  }
}
async function setup(speed = 400) {
  const sim = new SimulatorConnection({ speedFactor: speed })
  const client = new GrblClient(sim, { pollMs: 20 })
  let welcomed = false
  client.on('welcome', () => (welcomed = true))
  await client.connect()
  await until(() => welcomed && client.status.state === 'Idle')
  return { sim, client }
}
const squareJob = (n = 40) => {
  const lines = ['G21 G90', 'M4 S0']
  for (let i = 0; i < n; i++) {
    const y = i * 0.5
    lines.push(`G0 X0 Y${y}`, `G1 X20 Y${y} S500 F6000`)
  }
  lines.push('M5 S0')
  return lines
}

describe('GrblClient + simulator', () => {
  it('connects and tracks status, work coordinates and WCO', async () => {
    const { client } = await setup()
    client.send('G0 X10 Y5')
    await until(() => client.status.mpos.x > 9.99)
    client.setWorkZero()
    await until(() => client.status.wco.x > 9.9)
    await until(() => Math.abs(client.status.wpos.x) < 0.01)
    await client.disconnect()
  })

  it('streams a job without ever overflowing GRBL RX buffer, then finishes when machine is idle', async () => {
    const { sim, client } = await setup()
    const results: JobResult[] = []
    client.on('jobEnd', (e) => results.push(e.result))
    const job = squareJob()
    client.startJob(job)
    await until(() => results.length > 0)
    expect(results).toEqual(['done'])
    expect(sim.overflowed).toBe(false)
    expect(sim.machineState).toBe('Idle')
    expect(sim.busy).toBe(false)
    expect(sim.accepted.length).toBe(job.length)
    expect(sim.position.x).toBeCloseTo(20)
    await client.disconnect()
  })

  it('streams a generated job end-to-end and laser power never exceeds the request', async () => {
    const { sim, client } = await setup(2000)
    const layer = { ...defaultLayer('a', 'x', '#f00'), mode: 'fill' as const, speed: 200, power: 30, lineInterval: 0.5, overscan: 1 }
    const gen = generate(
      [{ settings: layer, vectors: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }], images: [] }],
      { machine: FALCON2_22W, origin: { mode: 'job', anchor: 'bl' }, returnToOrigin: true, constantPower: false },
    )
    let result = ''
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(gen.lines)
    await until(() => result !== '')
    expect(result).toBe('done')
    expect(sim.overflowed).toBe(false)
    expect(sim.maxLaserS).toBe(300)
    expect(sim.position.x).toBeCloseTo(0, 1)
    await client.disconnect()
  })

  it('pauses and resumes', async () => {
    const { sim, client } = await setup(10)
    let result = ''
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(squareJob(30))
    await sleep(60)
    client.pause()
    await until(() => client.status.state === 'Hold')
    const held = sim.position.y
    await sleep(100)
    expect(sim.position.y).toBe(held)
    expect(client.progress().state).toBe('paused')
    client.resume()
    await until(() => result !== '')
    expect(result).toBe('done')
    await client.disconnect()
  })

  it('stop flushes the planner, turns the laser off and ends the job as aborted', async () => {
    const { sim, client } = await setup(30)
    let result = ''
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(squareJob(60))
    await sleep(80)
    client.stop()
    await until(() => result !== '')
    expect(result).toBe('aborted')
    await until(() => sim.machineState === 'Idle' || sim.machineState === 'Alarm')
    expect(sim.busy).toBe(false)
    const pos = sim.position.y
    await sleep(100)
    expect(sim.position.y).toBe(pos)
    await client.disconnect()
  })

  it('aborts on a GRBL error and reports the offending line', async () => {
    const { sim, client } = await setup()
    sim.failOn(/Y3$|Y3F/, 20)
    const errs: any[] = []
    let result = ''
    client.on('error', (e) => errs.push(e))
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(['G21', 'M4 S0', 'G0 X0 Y0', 'G1 X5 Y3 F500 S100', 'G1 X10 Y3'])
    await until(() => result !== '')
    expect(result).toBe('error')
    expect(errs[0].code).toBe(20)
    await client.disconnect()
  })

  it('ends the job on alarm', async () => {
    const { sim, client } = await setup(20)
    let result = ''
    const alarms: number[] = []
    client.on('alarm', (a) => alarms.push(a.code))
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(squareJob(40))
    await sleep(50)
    sim.triggerAlarm(1)
    await until(() => result !== '')
    expect(result).toBe('error')
    expect(alarms).toEqual([1])
    await until(() => client.status.state === 'Alarm')
    expect(() => client.startJob(['G0 X1'])).toThrow(/alarm/i)
    client.unlock()
    await until(() => client.status.state === 'Idle')
    await client.disconnect()
  })

  it('reports a pulled cable as disconnected and ends the job', async () => {
    const { sim, client } = await setup(20)
    let result = ''
    client.on('jobEnd', (e) => (result = e.result))
    client.startJob(squareJob(40))
    await sleep(30)
    sim.yank()
    await until(() => result !== '')
    expect(result).toBe('disconnected')
    expect(client.status.state).toBe('Disconnected')
  })

  it('refuses manual commands during a job, rejects long lines, and refuses to start while not idle', async () => {
    const { client } = await setup(20)
    client.startJob(squareJob(40))
    expect(() => client.send('G0 X1')).toThrow(/job is running/)
    expect(() => client.startJob(['G0 X1'])).toThrow(/already/)
    client.emergencyStop()
    expect(() => GrblClient.prepareJob(['G1 X' + '1'.repeat(100)])).toThrow(/80/)
    await client.disconnect()
  })

  it('reads settings with $$ and sets overrides in steps', async () => {
    const { sim, client } = await setup()
    client.requestSettings()
    await until(() => client.settings[32] === '1')
    expect(client.settings[30]).toBe('1000')
    client.startJob(squareJob(40))
    client.setOverride('feed', 125)
    client.setOverride('spindle', 80)
    await until(() => client.status.overrides.feed === 125 && client.status.overrides.spindle === 80)
    client.emergencyStop()
    void sim
    await client.disconnect()
  })

  it('jogs, and jog cancel stops motion', async () => {
    const { sim, client } = await setup(10)
    client.jog({ x: 100 }, 3000)
    await sleep(50)
    client.jogCancel()
    await until(() => client.status.state === 'Idle')
    expect(sim.position.x).toBeLessThan(100)
    await client.disconnect()
  })

  it('laser test pulse really fires: G1 + M3 (GRBL laser mode is off in G0, and M4 is off at rest), then back to G0', async () => {
    const { sim, client } = await setup()
    await client.pulseLaser(5, 1000, 100)
    await until(() => sim.accepted.includes('G0'))
    expect(sim.accepted.slice(-4)).toEqual(['G1F1000M3S50', 'G4P0.10', 'M5S0', 'G0'])
    await until(() => sim.maxLaserS > 0)
    expect(sim.maxLaserS).toBe(50)
    await client.disconnect()
  })

  it('sends EEPROM-writing lines (G10, $ settings) alone, never streamed behind other lines', async () => {
    const { sim, client } = await setup()
    const sent: string[] = []
    const inflight: number[] = []
    const orig = sim.write.bind(sim)
    sim.write = (c: string) => {
      if (c.endsWith('\n')) (sent.push(c.trim()), inflight.push((client as unknown as { inFlight: number }).inFlight))
      orig(c)
    }
    client.startJob(['G10 L20 P1 X0 Y0', 'G1 X1 F600', 'G1 X2', 'G1 X3'], 'sync')
    await until(() => !client.jobActive, 5000)
    const i = sent.indexOf('G10L20P1X0Y0')
    expect(i).toBeGreaterThanOrEqual(0)
    // nothing else was in flight when G10 went out, and G10 had been acknowledged before the next line went
    expect(inflight[i]).toBe('G10L20P1X0Y0'.length + 1)
    expect(sim.overflowed).toBe(false)
    await client.disconnect()
  })

  it('stop waits for the feed hold to finish before resetting, so GRBL keeps its position', async () => {
    const { sim, client } = await setup()
    const lines = Array.from({ length: 200 }, (_, i) => `G1 X${(i % 2) * 50} Y${i * 0.1} S500 F3000`)
    client.startJob(['M4 S0', ...lines], 'long')
    await until(() => sim.machineState === 'Run')
    client.stop()
    expect(sim.machineState).not.toBe('Idle') // the reset is not sent at once
    await until(() => sim.machineState === 'Idle', 5000)
    await new Promise((r) => setTimeout(r, 300))
    expect(sim.machineState).toBe('Idle') // reset arrived after the hold finished: no ALARM:3
    await client.disconnect()
  })
})
