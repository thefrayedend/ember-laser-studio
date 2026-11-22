import type { DitherMode, ImageAdjust } from '../types'

/**
 * All ditherers work in place on a grayscale grid (0 = black/burn, 255 = white) and leave every pixel at 0 or 255.
 */
export function ditherInPlace(gray: Uint8Array, w: number, h: number, mode: Exclude<DitherMode, 'grayscale'>, threshold = 128): void {
  switch (mode) {
    case 'threshold':
      for (let i = 0; i < gray.length; i++) gray[i] = gray[i] < threshold ? 0 : 255
      return
    case 'bayer': {
      const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = ((m[(y & 3) * 4 + (x & 3)] + 0.5) / 16) * 255 + (threshold - 128)
          gray[y * w + x] = gray[y * w + x] < t ? 0 : 255
        }
      }
      return
    }
    case 'floyd':
    case 'atkinson':
      diffuse(gray, w, h, mode, threshold)
  }
}

function diffuse(gray: Uint8Array, w: number, h: number, mode: 'floyd' | 'atkinson', threshold: number) {
  // Three rolling rows of accumulated error keep memory flat for huge rasters.
  let r0 = new Float32Array(w + 4)
  let r1 = new Float32Array(w + 4)
  let r2 = new Float32Array(w + 4)
  const o = 2 // x offset inside error rows so we can write to x-2 .. x+2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const old = gray[y * w + x] + r0[x + o]
      const nv = old < threshold ? 0 : 255
      gray[y * w + x] = nv
      const err = old - nv
      if (mode === 'floyd') {
        r0[x + o + 1] += (err * 7) / 16
        r1[x + o - 1] += (err * 3) / 16
        r1[x + o] += (err * 5) / 16
        r1[x + o + 1] += err / 16
      } else {
        const e = err / 8
        r0[x + o + 1] += e
        r0[x + o + 2] += e
        r1[x + o - 1] += e
        r1[x + o] += e
        r1[x + o + 1] += e
        r2[x + o] += e
      }
    }
    const t = r0
    r0 = r1
    r1 = r2
    r2 = t
    r2.fill(0)
  }
}

/** 256-entry lookup applying brightness, contrast and invert. */
export function adjustLut(adj?: ImageAdjust): Uint8Array {
  const lut = new Uint8Array(256)
  const b = (adj?.brightness ?? 0) * 2.55
  const c = adj?.contrast ?? 0
  const factor = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55))
  for (let i = 0; i < 256; i++) {
    let v = factor * (i - 128) + 128 + b
    v = Math.max(0, Math.min(255, v))
    lut[i] = adj?.invert ? 255 - Math.round(v) : Math.round(v)
  }
  return lut
}

/** Bilinear sample of a grayscale bitmap. (u, v) are pixel coordinates; outside the bitmap returns 255 (white). */
export function sampleBilinear(gray: Uint8Array, w: number, h: number, u: number, v: number): number {
  if (u < -0.5 || v < -0.5 || u > w - 0.5 || v > h - 0.5) return 255
  const x = Math.max(0, Math.min(w - 1, u - 0.5))
  const y = Math.max(0, Math.min(h - 1, v - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const a = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx
  const b = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx
  return a * (1 - fy) + b * fy
}
