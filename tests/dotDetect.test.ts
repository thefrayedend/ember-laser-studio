import { describe, expect, it } from 'vitest'
import { applyH, quadToQuad } from '../src/core/geometry/homography'
import { calibrationPoints, designToWork, detectDot, fitCamera } from '../src/core/geometry/dotDetect'

function frame(w: number, h: number, v = 60) {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) a.set([v, v, v, 255], i * 4)
  return a
}
function addDot(a: Uint8ClampedArray, w: number, cx: number, cy: number, r = 3) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) a.set([255, 240, 240, 255], (y * w + x) * 4)
}

describe('detectDot', () => {
  it('finds a bright dot', () => {
    const w = 200,
      h = 120
    const base = frame(w, h)
    const f = frame(w, h)
    addDot(f, w, 150, 40)
    const d = detectDot(base, f, w, h)!
    expect(Math.abs(d.x - 150.5)).toBeLessThan(1.5)
    expect(Math.abs(d.y - 40.5)).toBeLessThan(1.5)
  })
  it('ignores mild noise and darkening', () => {
    const w = 100,
      h = 80
    const base = frame(w, h, 100)
    const f = frame(w, h, 90)
    expect(detectDot(base, f, w, h)).toBeNull()
  })
})

describe('fitCamera', () => {
  it('recovers bed corners from dots seen through a perspective camera', () => {
    const W = 400,
      H = 400
    const truth = [
      { x: 80, y: 60 },
      { x: 560, y: 90 },
      { x: 600, y: 420 },
      { x: 40, y: 380 },
    ]
    const Ht = quadToQuad([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], truth)
    const design = calibrationPoints(W, H)
    const cam = design.map((p) => applyH(Ht, p))
    const fit = fitCamera(design, cam, W, H)
    fit.corners.forEach((c, i) => {
      expect(Math.abs(c.x - truth[i].x)).toBeLessThan(0.01)
      expect(Math.abs(c.y - truth[i].y)).toBeLessThan(0.01)
    })
    expect(fit.checkErrorPx!).toBeLessThan(0.01)
  })
})

describe('designToWork', () => {
  it('front-left head start: moving right/back raises X and Y', () => {
    const c = { cx: 0, cy: 400 }
    expect(designToWork(40, 360, c, { x: 5, y: 7 })).toEqual({ x: 45, y: 47 })
  })
  it('back-right head start: moving left goes negative X, front goes negative Y', () => {
    const c = { cx: 400, cy: 0 }
    expect(designToWork(360, 40, c, { x: 0, y: 0 })).toEqual({ x: -40, y: -40 })
  })
})
