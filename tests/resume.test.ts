import { describe, expect, it } from 'vitest'
import { buildResume, findResumeLine, modalBefore } from '../src/core/gcode/resume'
import { GrblClient } from '../src/core/grbl/client'
import { SimulatorConnection } from '../src/core/connection/simulator'

const job = ['G10 L20 P1 X0 Y0', 'G54', 'G21', 'G90', 'M4', 'G0 X10 Y10', 'G1 X20 Y10 F1000 S500', 'G1 X20 Y20', 'G0 X30 Y30', 'G1 X40 Y30 S200', 'G1 X40 Y40', 'M5']

describe('resume', () => {
  it('tracks modal state and ignores G10 axis words', () => {
    const m = modalBefore(job, 8)
    expect([m.x, m.y, m.f, m.s, m.spindle, m.motion]).toEqual([20, 20, 1000, 500, 'M4', 1])
  })
  it('builds a safe preamble: laser off, rapid to start, then state restored', () => {
    const r = buildResume(job, 9)
    const rapid = r.indexOf('G0 X30 Y30')
    expect(rapid).toBeGreaterThan(0)
    expect(r.indexOf('M5')).toBeLessThan(rapid)
    expect(r.indexOf('M4 S500')).toBeGreaterThan(rapid)
    expect(r.indexOf('F1000')).toBeGreaterThan(rapid)
    expect(r.slice(-3)).toEqual(['G1 X40 Y30 S200', 'G1 X40 Y40', 'M5'])
    expect(r.some((l) => l.startsWith('G10'))).toBe(false)
  })
  it('M3 laser starts at S0 and patches the first cutting move', () => {
    const l = ['G21', 'G90', 'M3 S0', 'G0 X5 Y5', 'G1 X10 Y5 F600 S800', 'G1 X10 Y10', 'G1 X20 Y10', 'M5']
    const r = buildResume(l, 6)
    expect(r).toContain('M3 S0')
    expect(r.find((x) => x.startsWith('G1 X20'))).toBe('G1 X20 Y10 S800')
  })
  it('relative mode keeps position math right', () => {
    const l = ['G91', 'G1 X5 F500', 'G1 Y5', 'G1 X5']
    const r = buildResume(l, 3)
    expect(r).toContain('G0 X5 Y5')
    expect(r).toContain('G91')
  })
  it('finds the line nearest where the head stopped', () => {
    expect(findResumeLine(job, { x: 20, y: 15 }, 0, 11)).toBe(7)
    expect(findResumeLine(job, { x: 35, y: 30 }, 0, 11)).toBe(9)
  })
  it('a resumed job runs on the simulator and ends at the same place as the full job', async () => {
    const run = async (lines: string[]) => {
      const sim = new SimulatorConnection()
      const c = new GrblClient(sim)
      await c.connect()
      await new Promise((r) => setTimeout(r, 50))
      c.startJob(lines, 't')
      await new Promise<void>((res) => c.on('jobEnd', () => res()))
      return { pos: sim.position, ovf: sim.overflowed }
    }
    const full = await run(['G21', 'G90', ...job.slice(4)])
    const part = await run(buildResume(['G21', 'G90', ...job.slice(4)], 7))
    expect(part.ovf).toBe(false)
    expect(part.pos.x).toBeCloseTo(full.pos.x)
    expect(part.pos.y).toBeCloseTo(full.pos.y)
  }, 20000)
})
