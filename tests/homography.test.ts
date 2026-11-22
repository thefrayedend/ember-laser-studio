import { expect, it } from 'vitest'
import { applyH, cssMatrix3d, quadToQuad } from '../src/core/geometry/homography'

it('maps the four corners exactly and interior points sensibly', () => {
  const src = [{ x: 100, y: 80 }, { x: 540, y: 60 }, { x: 600, y: 420 }, { x: 50, y: 400 }]
  const dst = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 415 }, { x: 0, y: 415 }]
  const h = quadToQuad(src, dst)
  src.forEach((s, i) => {
    const r = applyH(h, s)
    expect(r.x).toBeCloseTo(dst[i].x, 6)
    expect(r.y).toBeCloseTo(dst[i].y, 6)
  })
  const mid = applyH(h, { x: 322, y: 240 })
  expect(mid.x).toBeGreaterThan(100)
  expect(mid.x).toBeLessThan(300)
  expect(cssMatrix3d(h)).toMatch(/^matrix3d\((.*,){15}[^,]*\)$/)
})
it('rejects degenerate corners', () => {
  const p = { x: 1, y: 1 }
  expect(() => quadToQuad([p, p, p, p], [p, p, p, p])).toThrow()
})
