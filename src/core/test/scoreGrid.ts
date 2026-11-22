import { applyH, quadToQuad, type P2 } from '../geometry/homography'

export interface Cell {
  r: number // row, 0 = the bottom row of the test (lowest power)
  c: number // column, 0 = the left column (slowest... as listed)
  lum: number // mean brightness inside the square, 0-255
  /** 0 = same as the plain material around the test, 1 = black */
  darkness: number
  /** brightness variation inside the square relative to the material (high = patchy or charred edges) */
  spread: number
}

export interface GridGeometry {
  cols: number
  rows: number
  cell: number // mm
  gap: number // mm
}

export const grayOf = (rgba: ArrayLike<number>, w: number, h: number) => {
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
  return g
}

export const gridSizeMm = (g: GridGeometry) => ({ w: g.cols * g.cell + (g.cols - 1) * g.gap, h: g.rows * g.cell + (g.rows - 1) * g.gap })

/**
 * The picture is a top-down view; `rect` is where the whole grid sits in it (pixels, top-left to bottom-right).
 * Each square is measured on its inner 60% so edges and neighbours do not leak in.
 */
export function scoreGrid(gray: Float32Array, w: number, h: number, rect: { x0: number; y0: number; x1: number; y1: number }, g: GridGeometry): { cells: Cell[]; reference: number } {
  const size = gridSizeMm(g)
  const sx = (rect.x1 - rect.x0) / size.w
  const sy = (rect.y1 - rect.y0) / size.h
  const at = (x: number, y: number) => gray[Math.max(0, Math.min(h - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)))]

  // The plain material: a band around the grid, one gap wide (at least 4 px).
  const band = Math.max(4, g.gap * Math.min(sx, sy))
  const ref: number[] = []
  const sample = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y += 2) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x += 2) ref.push(gray[y * w + x])
  }
  sample(rect.x0 - band * 2, rect.y0 - band * 2, rect.x1 + band * 2, rect.y0 - band * 0.5)
  sample(rect.x0 - band * 2, rect.y1 + band * 0.5, rect.x1 + band * 2, rect.y1 + band * 2)
  sample(rect.x0 - band * 2, rect.y0, rect.x0 - band * 0.5, rect.y1)
  sample(rect.x1 + band * 0.5, rect.y0, rect.x1 + band * 2, rect.y1)
  ref.sort((a, b) => a - b)
  const reference = ref.length ? ref[Math.floor(ref.length / 2)] : 200

  const cells: Cell[] = []
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const mmX = c * (g.cell + g.gap)
      const mmYFromBottom = r * (g.cell + g.gap)
      const x0 = rect.x0 + (mmX + g.cell * 0.2) * sx
      const x1 = rect.x0 + (mmX + g.cell * 0.8) * sx
      const yBot = rect.y1 - mmYFromBottom * sy
      const y0 = yBot - g.cell * 0.8 * sy
      const y1 = yBot - g.cell * 0.2 * sy
      let n = 0
      let sum = 0
      let sum2 = 0
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const v = at(x, y)
          sum += v
          sum2 += v * v
          n++
        }
      const mean = n ? sum / n : reference
      const sd = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0
      cells.push({ r, c, lum: mean, darkness: Math.max(0, Math.min(1, (reference - mean) / Math.max(1, reference))), spread: sd / Math.max(1, reference) })
    }
  return { cells, reference }
}

/** Flatten a camera picture into a top-down picture of the bed (corners TL, TR, BR, BL in camera pixels). */
export function warpToBed(src: ArrayLike<number>, sw: number, sh: number, corners: P2[], bedW: number, bedH: number, pxPerMm: number) {
  const ow = Math.round(bedW * pxPerMm)
  const oh = Math.round(bedH * pxPerMm)
  const H = quadToQuad(
    [{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }],
    corners,
  )
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const p = applyH(H, { x: x + 0.5, y: y + 0.5 })
      const ix = Math.floor(p.x)
      const iy = Math.floor(p.y)
      const o = (y * ow + x) * 4
      if (ix < 0 || iy < 0 || ix >= sw - 1 || iy >= sh - 1) {
        out[o + 3] = 255
        continue
      }
      const fx = p.x - ix
      const fy = p.y - iy
      for (let k = 0; k < 3; k++) {
        const a = src[(iy * sw + ix) * 4 + k]
        const b = src[(iy * sw + ix + 1) * 4 + k]
        const c = src[((iy + 1) * sw + ix) * 4 + k]
        const d = src[((iy + 1) * sw + ix + 1) * 4 + k]
        out[o + k] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
      }
      out[o + 3] = 255
    }
  return { data: out, w: ow, h: oh }
}
