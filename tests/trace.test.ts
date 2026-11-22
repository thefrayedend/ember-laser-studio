import { describe, expect, it } from 'vitest'
import { DEFAULT_TRACE, polylinesToPath, traceBitmap } from '../src/core/raster/trace'
import { flattenPath, polylineBounds } from '../src/core/geometry/path'

const bitmap = (w: number, h: number, fn: (x: number, y: number) => boolean) => {
  const g = new Uint8Array(w * h).fill(255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fn(x, y)) g[y * w + x] = 0
  return g
}

describe('trace outline', () => {
  it('traces a filled circle as one closed loop with right bounds', () => {
    const g = bitmap(100, 100, (x, y) => Math.hypot(x - 50, y - 50) < 30)
    const r = traceBitmap(g, 100, 100, DEFAULT_TRACE)
    expect(r).toHaveLength(1)
    expect(r[0].closed).toBe(true)
    const b = polylineBounds(r)!
    expect(b.minX).toBeGreaterThan(18)
    expect(b.minX).toBeLessThan(22)
    expect(b.maxX).toBeGreaterThan(78)
    expect(b.maxX).toBeLessThan(82)
    expect(r[0].points.length).toBeLessThan(120) // simplified, not one point per pixel edge
  })
  it('finds the hole in a ring', () => {
    const g = bitmap(100, 100, (x, y) => { const d = Math.hypot(x - 50, y - 50); return d < 35 && d > 15 })
    expect(traceBitmap(g, 100, 100)).toHaveLength(2)
  })
  it('separates blobs, drops speckles, honours invert', () => {
    const g = bitmap(80, 40, (x, y) => (x > 5 && x < 25 && y > 5 && y < 25) || (x > 45 && x < 70 && y > 10 && y < 30) || (x === 40 && y === 3))
    expect(traceBitmap(g, 80, 40)).toHaveLength(2)
    // inverted: the page becomes ink: one big outer loop plus two holes
    expect(traceBitmap(g, 80, 40, { ...DEFAULT_TRACE, invert: true })).toHaveLength(3)
  })
  it('output path round-trips through flattenPath with scaling', () => {
    const g = bitmap(40, 40, (x, y) => x > 10 && x < 30 && y > 10 && y < 30)
    const d = polylinesToPath(traceBitmap(g, 40, 40, { ...DEFAULT_TRACE, smooth: 0 }), 0.5)
    const b = polylineBounds(flattenPath(d))!
    expect(b.minX).toBeCloseTo(5.5, 0)
    expect(b.maxX).toBeCloseTo(15, 0)
  })
  it('diagonal pinch point does not hang or lose loops', () => {
    const g = bitmap(6, 6, (x, y) => (x === 2 && y === 2) || (x === 3 && y === 3))
    const r = traceBitmap(g, 6, 6, { ...DEFAULT_TRACE, minArea: 0, tolerance: 0, smooth: 0 })
    expect(r.length).toBeGreaterThanOrEqual(1)
  })
})

describe('trace centerline', () => {
  it('reduces a thick bar to a single centre path', () => {
    const g = bitmap(80, 30, (x, y) => x > 10 && x < 70 && y > 10 && y < 18)
    const r = traceBitmap(g, 80, 30, { ...DEFAULT_TRACE, mode: 'centerline' })
    expect(r).toHaveLength(1)
    const b = polylineBounds(r)!
    expect(b.maxX - b.minX).toBeGreaterThan(45)
    expect(b.maxY - b.minY).toBeLessThan(3)
    expect(b.minY).toBeGreaterThan(11)
    expect(b.maxY).toBeLessThan(18)
  })
  it('keeps a T shape connected at the junction', () => {
    const g = bitmap(60, 60, (x, y) => (y > 8 && y < 14 && x > 8 && x < 52) || (x > 27 && x < 33 && y >= 14 && y < 52))
    const r = traceBitmap(g, 60, 60, { ...DEFAULT_TRACE, mode: 'centerline' })
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r.length).toBeLessThanOrEqual(6)
  })
  it('closes a ring', () => {
    const g = bitmap(80, 80, (x, y) => { const d = Math.hypot(x - 40, y - 40); return d < 25 && d > 19 })
    const r = traceBitmap(g, 80, 80, { ...DEFAULT_TRACE, mode: 'centerline' })
    expect(r.some((l) => l.closed)).toBe(true)
  })
})
