import { applyH, quadToQuad, type P2 } from './homography'

export interface Dot {
  x: number
  y: number
  /** mean colour change (0-765) in the 7x7 window at the peak */
  score: number
}

/**
 * Find the laser dot: the place where the picture got brighter between two RGBA frames of the same size.
 * Uses a 7x7 box average so single noisy pixels are not mistaken for a dot.
 */
export function detectDot(base: ArrayLike<number>, frame: ArrayLike<number>, w: number, h: number, minScore = 18): Dot | null {
  const R = 3
  if (w < 2 * R + 1 || h < 2 * R + 1) return null
  const d = new Float32Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    // brighter only: the dot adds light, while shadows and auto-exposure drift go both ways
    d[i] = Math.max(0, frame[p] - base[p]) + Math.max(0, frame[p + 1] - base[p + 1]) + Math.max(0, frame[p + 2] - base[p + 2])
  }
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += d[y * w + x]
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row
    }
  }
  const area = (2 * R + 1) ** 2
  let best = -1
  let bx = 0
  let by = 0
  for (let y = R; y < h - R; y++) {
    for (let x = R; x < w - R; x++) {
      const s =
        sat[(y + R + 1) * (w + 1) + x + R + 1] - sat[(y - R) * (w + 1) + x + R + 1] - sat[(y + R + 1) * (w + 1) + x - R] + sat[(y - R) * (w + 1) + x - R]
      if (s > best) (best = s), (bx = x), (by = y)
    }
  }
  const score = best / area
  if (score < minScore) return null
  // centroid of the change inside the window
  let sw = 0
  let sx = 0
  let sy = 0
  for (let y = by - R; y <= by + R; y++)
    for (let x = bx - R; x <= bx + R; x++) {
      const v = d[y * w + x]
      sw += v
      sx += v * x
      sy += v * y
    }
  return sw > 0 ? { x: sx / sw + 0.5, y: sy / sw + 0.5, score } : { x: bx + 0.5, y: by + 0.5, score }
}

export interface CameraFit {
  /** bed corners TL, TR, BR, BL in camera pixels */
  corners: P2[]
  /** how far (camera pixels) the extra check point landed from where the fit predicted, if one was given */
  checkErrorPx: number | null
}

/**
 * design: positions in design mm (y down) where the head was; cam: where the camera saw it.
 * The first four pairs build the fit; a fifth, if present, is only used to report how good it is.
 */
export function fitCamera(design: P2[], cam: P2[], bedW: number, bedH: number): CameraFit {
  const H = quadToQuad(design.slice(0, 4), cam.slice(0, 4))
  const corners = [
    { x: 0, y: 0 },
    { x: bedW, y: 0 },
    { x: bedW, y: bedH },
    { x: 0, y: bedH },
  ].map((p) => applyH(H, p))
  let checkErrorPx: number | null = null
  if (design.length > 4 && cam.length > 4) {
    const p = applyH(H, design[4])
    checkErrorPx = Math.hypot(p.x - cam[4].x, p.y - cam[4].y)
  }
  return { corners, checkErrorPx }
}

/** Design-space (mm, y down) point -> machine work coordinates, given the head sits at one bed corner at (x0,y0). */
export function designToWork(dx: number, dy: number, corner: { cx: number; cy: number }, head: { x: number; y: number }): { x: number; y: number } {
  return { x: head.x + dx - corner.cx, y: head.y + corner.cy - dy }
}

/** Where the wizard points the head: inset from the edges so it never drives into a limit. */
export function calibrationPoints(bedW: number, bedH: number, inset = 0.1): P2[] {
  const a = inset
  const b = 1 - inset
  return [
    { x: a * bedW, y: a * bedH },
    { x: b * bedW, y: a * bedH },
    { x: b * bedW, y: b * bedH },
    { x: a * bedW, y: b * bedH },
    { x: bedW / 2, y: bedH / 2 },
  ]
}
