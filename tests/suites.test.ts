import { describe, expect, it } from 'vitest'
import { FALCON2_12W } from '../src/core/types'
import { TESTS, buildTest } from '../src/core/test/suites'

const input = { machine: FALCON2_12W, origin: { mode: 'job', anchor: 'bl' } as const, speed: 66, power: 40, speeds: [33, 66, 99], powers: [20, 40], thickness: 3 }

describe('material test suites', () => {
  for (const t of TESTS)
    it(`${t.id} builds clean G-code that fits the bed`, () => {
      const b = buildTest(t.id, input)
      expect(b.result.lines.length).toBeGreaterThan(10)
      expect(b.result.warnings.filter((w) => !/not in laser mode/.test(w))).toEqual([])
      expect(b.result.lines.some((l) => /S\d+/.test(l) && /^G1/.test(l))).toBe(true)
      expect(b.note.length).toBeGreaterThan(10)
      if (b.grid) expect(b.grid.cells.length).toBe(b.grid.cols * b.grid.rows)
      else expect(b.prompt).toBeTruthy()
    })

  it('puts the lowest power row at the bottom of the picture', () => {
    const b = buildTest('engrave', input)
    const burn = b.result.lines.filter((l) => /^G1.*S[1-9]/.test(l))
    // job origin is bottom-left, so the first burned square (highest row) has the larger Y
    const y = (l: string) => Number(/Y(-?[\d.]+)/.exec(l)![1])
    expect(y(burn[0])).toBeGreaterThan(y(burn[burn.length - 1]))
    expect(b.grid!.cells[0].settings.power).toBe(20)
  })

  it('air test marks the right half as air on', () => {
    const b = buildTest('air', input)
    expect(b.grid!.cols).toBe(6)
    expect(b.grid!.cells[3].settings.airAssist).toBe(true)
    expect(b.result.lines.filter((l) => l === 'M8').length).toBe(6)
  })
})
