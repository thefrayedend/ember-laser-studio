import { describe, expect, it } from 'vitest'
import { grayOf, scoreGrid, warpToBed } from '../src/core/test/scoreGrid'

describe('scoreGrid', () => {
  it('finds the darkest squares and reads the plain material as the reference', () => {
    const geom = { cols: 3, rows: 2, cell: 8, gap: 2 }
    const sc = 10 // px per mm
    const W = 400,
      H = 300
    const g = new Float32Array(W * H).fill(200)
    // grid occupies x 50..(50+28*10), y 80..(80+18*10); mark cell c=2,r=0 (bottom right) black, c=1,r=1 mid grey
    const paint = (c: number, r: number, v: number) => {
      const x0 = 50 + c * 10 * sc
      const yBottom = 80 + 18 * sc - r * 10 * sc
      for (let y = yBottom - 8 * sc; y < yBottom; y++) for (let x = x0; x < x0 + 8 * sc; x++) g[Math.floor(y) * W + Math.floor(x)] = v
    }
    paint(2, 0, 20)
    paint(1, 1, 120)
    const { cells, reference } = scoreGrid(g, W, H, { x0: 50, y0: 80, x1: 50 + 28 * sc, y1: 80 + 18 * sc }, geom)
    expect(reference).toBe(200)
    const at = (c: number, r: number) => cells.find((x) => x.c === c && x.r === r)!
    expect(at(2, 0).darkness).toBeGreaterThan(0.85)
    expect(at(1, 1).darkness).toBeGreaterThan(0.3)
    expect(at(1, 1).darkness).toBeLessThan(0.5)
    expect(at(0, 0).darkness).toBeLessThan(0.05)
  })
})

describe('warpToBed', () => {
  it('maps a rectangle in the picture onto the output unchanged', () => {
    const w = 40,
      h = 30
    const src = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src.set([x * 6, y * 8, 0, 255], (y * w + x) * 4)
    const out = warpToBed(src, w, h, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], 40, 30, 1)
    expect(out.w).toBe(40)
    expect(Math.abs(out.data[(15 * 40 + 20) * 4] - 20 * 6)).toBeLessThan(8)
    expect(grayOf(out.data, out.w, out.h).length).toBe(1200)
  })
})
