import type { Point, Polyline } from '../types'

export interface TraceOptions {
  /** 0..255. Pixels darker than this count as ink. */
  threshold: number
  /** Trace the light parts instead of the dark parts. */
  invert: boolean
  /** Simplification tolerance in pixels. Larger = fewer points, rounder curves. */
  tolerance: number
  /** Ignore blobs and holes smaller than this many pixels (outline mode) */
  minArea: number
  /** Chaikin corner-cutting passes after simplification (0 to 3) */
  smooth: number
  /** outline = trace the edges of black areas, centerline = trace the middle of thin strokes */
  mode: 'outline' | 'centerline'
}

export const DEFAULT_TRACE: TraceOptions = { threshold: 128, invert: false, tolerance: 0.8, minArea: 12, smooth: 1, mode: 'outline' }

export function binarize(gray: Uint8Array, threshold: number, invert: boolean): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold !== invert ? 1 : 0
  return out
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Douglas-Peucker on an open point list (iterative, safe for very long runs). */
export function simplifyOpen(pts: Point[], tol: number): Point[] {
  if (pts.length < 3 || tol <= 0) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let bestD = tol
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b])
      if (d > bestD) (bestD = d), (best = i)
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Closed loop: split at the point farthest from the start so DP has two stable anchors. */
export function simplifyClosed(pts: Point[], tol: number): Point[] {
  if (pts.length < 5 || tol <= 0) return pts
  let far = 0
  let fd = -1
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y)
    if (d > fd) (fd = d), (far = i)
  }
  const a = simplifyOpen(pts.slice(0, far + 1), tol)
  const b = simplifyOpen([...pts.slice(far), pts[0]], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

export function chaikin(pts: Point[], closed: boolean, passes: number): Point[] {
  let p = pts
  for (let k = 0; k < passes && p.length > 2; k++) {
    const out: Point[] = []
    const n = p.length
    const last = closed ? n : n - 1
    if (!closed) out.push(p[0])
    for (let i = 0; i < last; i++) {
      const a = p[i]
      const b = p[(i + 1) % n]
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y })
    }
    if (!closed) out.push(p[n - 1])
    p = out
  }
  return p
}

const area = (pts: Point[]) => {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/** Edge-following outline tracer. Black pixels are on the right of every directed edge, so holes come out as separate loops. */
export function traceOutlines(bin: Uint8Array, w: number, h: number): Point[][] {
  const W = w + 1
  const px = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x])
  // edges stored as parallel arrays: start corner id, end corner id
  const from: number[] = []
  const to: number[] = []
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    from.push(y0 * W + x0)
    to.push(y1 * W + x1)
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue
      if (!px(x, y - 1)) add(x, y, x + 1, y)
      if (!px(x + 1, y)) add(x + 1, y, x + 1, y + 1)
      if (!px(x, y + 1)) add(x + 1, y + 1, x, y + 1)
      if (!px(x - 1, y)) add(x, y + 1, x, y)
    }
  const starts = new Map<number, number[]>()
  from.forEach((c, i) => {
    const l = starts.get(c)
    if (l) l.push(i)
    else starts.set(c, [i])
  })
  const used = new Uint8Array(from.length)
  const loops: Point[][] = []
  const cx = (c: number) => c % W
  const cy = (c: number) => Math.floor(c / W)
  for (let e0 = 0; e0 < from.length; e0++) {
    if (used[e0]) continue
    const pts: Point[] = []
    let e = e0
    for (;;) {
      used[e] = 1
      const a = from[e]
      const b = to[e]
      const dx = cx(b) - cx(a)
      const dy = cy(b) - cy(a)
      // keep only corners where direction changes
      pts.push({ x: cx(a), y: cy(a) })
      const cands = (starts.get(b) ?? []).filter((i) => !used[i])
      if (!cands.length) break
      let next = cands[0]
      if (cands.length > 1) {
        // at a pinch point prefer the right turn (screen coordinates), which keeps diagonal neighbours connected
        for (const c of cands) {
          const ndx = cx(to[c]) - cx(from[c])
          const ndy = cy(to[c]) - cy(from[c])
          if (dx * ndy - dy * ndx > 0) next = c
        }
      }
      e = next
      if (e === e0) break
    }
    // drop collinear points
    const clean: Point[] = []
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[(i + pts.length - 1) % pts.length]
      const p1 = pts[i]
      const p2 = pts[(i + 1) % pts.length]
      if ((p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x) !== 0) clean.push(p1)
    }
    if (clean.length >= 3) loops.push(clean)
  }
  return loops
}

/** Zhang-Suen thinning. Returns a new 0/1 skeleton. */
export function thin(bin: Uint8Array, w: number, h: number): Uint8Array {
  const img = bin.slice()
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x])
  const del: number[] = []
  let changed = true
  while (changed) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1)
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1)
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (B < 2 || B > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let A = 0
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++
          if (A !== 1) continue
          if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
          del.push(y * w + x)
        }
      if (del.length) changed = true
      for (const i of del) img[i] = 0
    }
  }
  return img
}

/** Walk a 1px skeleton into polylines between endpoints and junctions. */
export function skeletonToPaths(sk: Uint8Array, w: number, h: number): Point[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : sk[y * w + x])
  const nb = (i: number): number[] => {
    const x = i % w
    const y = (i / w) | 0
    const out: number[] = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        if (!at(x + dx, y + dy)) continue
        // drop a diagonal neighbour when an orthogonal path already connects it (removes staircase corners)
        if (dx && dy && (at(x + dx, y) || at(x, y + dy))) continue
        out.push((y + dy) * w + (x + dx))
      }
    return out
  }
  const deg = new Map<number, number[]>()
  for (let i = 0; i < sk.length; i++) if (sk[i]) deg.set(i, nb(i))
  const seen = new Set<string>()
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const paths: Point[][] = []
  const pt = (i: number): Point => ({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 })
  const walk = (start: number, first: number) => {
    const pts = [pt(start)]
    let prev = start
    let cur = first
    seen.add(key(prev, cur))
    for (;;) {
      pts.push(pt(cur))
      const n = deg.get(cur)!
      if (n.length !== 2) break
      const next = n[0] === prev ? n[1] : n[0]
      if (seen.has(key(cur, next))) break
      seen.add(key(cur, next))
      prev = cur
      cur = next
    }
    paths.push(pts)
  }
  for (const [i, n] of deg) if (n.length !== 2) for (const j of n) if (!seen.has(key(i, j))) walk(i, j)
  for (const [i, n] of deg) if (n.length === 2) for (const j of n) if (!seen.has(key(i, j))) walk(i, j) // closed rings
  return paths
}

/** Trace a grayscale bitmap into polylines in pixel coordinates. */
export function traceBitmap(gray: Uint8Array, w: number, h: number, o: TraceOptions = DEFAULT_TRACE): Polyline[] {
  const bin = binarize(gray, o.threshold, o.invert)
  const out: Polyline[] = []
  if (o.mode === 'centerline') {
    const sk = thin(bin, w, h)
    for (const p of skeletonToPaths(sk, w, h)) {
      let len = 0
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
      if (len < Math.max(3, Math.sqrt(o.minArea))) continue
      const closed = p.length > 3 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) < 1.5
      let pts = simplifyOpen(closed ? p.slice(0, -1) : p, o.tolerance)
      pts = chaikin(pts, closed, o.smooth)
      out.push({ points: pts, closed })
    }
    return out
  }
  for (const loop of traceOutlines(bin, w, h)) {
    if (area(loop) < o.minArea) continue
    let pts = simplifyClosed(loop, o.tolerance)
    if (pts.length < 3) continue
    pts = chaikin(pts, true, o.smooth)
    out.push({ points: pts, closed: true })
  }
  return out
}

/** Path data (d) for polylines, with coordinates scaled by (sx, sy). */
export function polylinesToPath(lines: Polyline[], sx = 1, sy = sx): string {
  const f = (n: number) => String(Math.round(n * 1e3) / 1e3)
  return lines
    .map((l) => 'M' + l.points.map((p) => `${f(p.x * sx)} ${f(p.y * sy)}`).join('L') + (l.closed ? 'Z' : ''))
    .join('')
}
