import type { Matrix, Point, Polyline, Rect } from '../types'
import { apply } from './matrix'

/** Absolute path segments. Everything is normalised to M, L, C and Z so transforms and flattening stay simple. */
export type Seg =
  | { t: 'M' | 'L'; p: [number, number] }
  | { t: 'C'; p: [number, number, number, number, number, number] }
  | { t: 'Z' }

const ARGC: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) out.push(m[1] ?? Number(m[2]))
  return out
}

/** Arc (SVG endpoint form) to cubic beziers. */
function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Seg[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ t: 'L', p: [x2, y2] }]
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coef = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) coef = -coef
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  if (sweep && dth < 0) dth += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9))
  const step = dth / n
  const t = (4 / 3) * Math.tan(step / 4)
  const out: Seg[] = []
  let a = th1
  for (let i = 0; i < n; i++) {
    const a2 = a + step
    const c1 = Math.cos(a)
    const s1 = Math.sin(a)
    const c2 = Math.cos(a2)
    const s2 = Math.sin(a2)
    const pt = (px: number, py: number): [number, number] => [
      cos * rx * px - sin * ry * py + cx,
      sin * rx * px + cos * ry * py + cy,
    ]
    const p1 = pt(c1 - t * s1, s1 + t * c1)
    const p2 = pt(c2 + t * s2, s2 - t * c2)
    const p3 = i === n - 1 ? ([x2, y2] as [number, number]) : pt(c2, s2)
    out.push({ t: 'C', p: [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]] })
    a = a2
  }
  return out
}

export function parsePath(d: string): Seg[] {
  const tok = tokenize(d)
  const segs: Seg[] = []
  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let lastC: [number, number] | null = null // last cubic control point (for S)
  let lastQ: [number, number] | null = null // last quad control point (for T)
  const num = () => {
    const v = tok[i++]
    return typeof v === 'number' ? v : NaN
  }
  while (i < tok.length) {
    const t = tok[i]
    if (typeof t === 'string') {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        segs.push({ t: 'Z' })
        cx = sx
        cy = sy
        lastC = lastQ = null
        continue
      }
    } else if (!cmd) {
      break
    }
    const up = cmd.toUpperCase()
    const rel = cmd !== up
    const need = ARGC[up]
    if (need === undefined) break
    const a: number[] = []
    for (let k = 0; k < need; k++) a.push(num())
    if (a.some(Number.isNaN)) break
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    let nextC: [number, number] | null = null
    let nextQ: [number, number] | null = null
    switch (up) {
      case 'M':
        cx = a[0] + ox
        cy = a[1] + oy
        sx = cx
        sy = cy
        segs.push({ t: 'M', p: [cx, cy] })
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        cx = a[0] + ox
        cy = a[1] + oy
        segs.push({ t: 'L', p: [cx, cy] })
        break
      case 'H':
        cx = a[0] + ox
        segs.push({ t: 'L', p: [cx, cy] })
        break
      case 'V':
        cy = a[0] + oy
        segs.push({ t: 'L', p: [cx, cy] })
        break
      case 'C': {
        const p: Seg = { t: 'C', p: [a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy] }
        segs.push(p)
        nextC = [p.p[2], p.p[3]]
        cx = p.p[4]
        cy = p.p[5]
        break
      }
      case 'S': {
        const c1: [number, number] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy]
        const p: Seg = { t: 'C', p: [c1[0], c1[1], a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy] }
        segs.push(p)
        nextC = [p.p[2], p.p[3]]
        cx = p.p[4]
        cy = p.p[5]
        break
      }
      case 'Q':
      case 'T': {
        let qx: number
        let qy: number
        let ex: number
        let ey: number
        if (up === 'Q') {
          qx = a[0] + ox
          qy = a[1] + oy
          ex = a[2] + ox
          ey = a[3] + oy
        } else {
          const q: [number, number] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy]
          qx = q[0]
          qy = q[1]
          ex = a[0] + ox
          ey = a[1] + oy
        }
        segs.push({
          t: 'C',
          p: [cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey],
        })
        nextQ = [qx, qy]
        cx = ex
        cy = ey
        break
      }
      case 'A': {
        const ex = a[5] + ox
        const ey = a[6] + oy
        segs.push(...arcToCubics(cx, cy, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, ex, ey))
        cx = ex
        cy = ey
        break
      }
    }
    lastC = nextC
    lastQ = nextQ
  }
  return segs
}

export function serializePath(segs: Seg[]): string {
  const f = (n: number) => String(Math.round(n * 1e4) / 1e4)
  return segs
    .map((s) => (s.t === 'Z' ? 'Z' : `${s.t}${s.p.map(f).join(' ')}`))
    .join('')
}

export function transformSegs(segs: Seg[], m: Matrix): Seg[] {
  return segs.map((s): Seg => {
    if (s.t === 'Z') return s
    if (s.t === 'C') {
      const a = apply(m, { x: s.p[0], y: s.p[1] })
      const b = apply(m, { x: s.p[2], y: s.p[3] })
      const c = apply(m, { x: s.p[4], y: s.p[5] })
      return { t: 'C', p: [a.x, a.y, b.x, b.y, c.x, c.y] }
    }
    const a = apply(m, { x: s.p[0], y: s.p[1] })
    return { t: s.t, p: [a.x, a.y] }
  })
}

/** Convert segments to polylines. `tol` is the maximum chord error in the same units as the path (mm). */
export function flattenSegs(segs: Seg[], tol = 0.05): Polyline[] {
  const out: Polyline[] = []
  let cur: Point[] = []
  let start: Point | null = null
  let pos: Point = { x: 0, y: 0 }
  const flush = (closed: boolean) => {
    if (cur.length > 1 || (closed && cur.length > 0)) out.push({ points: cur, closed })
    cur = []
  }
  for (const s of segs) {
    if (s.t === 'M') {
      flush(false)
      pos = { x: s.p[0], y: s.p[1] }
      start = pos
      cur = [pos]
    } else if (s.t === 'L') {
      if (!cur.length) cur = [pos]
      pos = { x: s.p[0], y: s.p[1] }
      cur.push(pos)
    } else if (s.t === 'C') {
      if (!cur.length) cur = [pos]
      const p0 = pos
      const [x1, y1, x2, y2, x3, y3] = s.p
      // Segment count from control polygon length; bounded error for typical curves.
      const len =
        Math.hypot(x1 - p0.x, y1 - p0.y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
      const n = Math.max(2, Math.min(200, Math.ceil(Math.sqrt(len / tol) * 0.7)))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        cur.push({
          x: u * u * u * p0.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          y: u * u * u * p0.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        })
      }
      pos = { x: x3, y: y3 }
    } else {
      if (cur.length) {
        const first = cur[0]
        const last = cur[cur.length - 1]
        if (cur.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) cur.pop()
        flush(true)
      }
      if (start) pos = start
    }
  }
  flush(false)
  return out
}

export function flattenPath(d: string, tol = 0.05, m?: Matrix): Polyline[] {
  let segs = parsePath(d)
  if (m) segs = transformSegs(segs, m)
  return flattenSegs(segs, tol)
}

export function polylineBounds(lines: Polyline[]): Rect | null {
  let r: Rect | null = null
  for (const l of lines) {
    for (const p of l.points) {
      if (!r) r = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
      else {
        if (p.x < r.minX) r.minX = p.x
        if (p.y < r.minY) r.minY = p.y
        if (p.x > r.maxX) r.maxX = p.x
        if (p.y > r.maxY) r.maxY = p.y
      }
    }
  }
  return r
}

export function polygonArea(pts: Point[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// Handy shape constructors that return path data in local mm, origin at top-left.
export const rectPath = (w: number, h: number) => `M0 0L${w} 0L${w} ${h}L0 ${h}Z`
export function ellipsePath(w: number, h: number) {
  const rx = w / 2
  const ry = h / 2
  return `M0 ${ry}A${rx} ${ry} 0 1 1 ${w} ${ry}A${rx} ${ry} 0 1 1 0 ${ry}Z`
}
export function polygonPath(sides: number, w: number, h: number) {
  const pts: string[] = []
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2
    pts.push(`${(Math.cos(a) * 0.5 + 0.5) * w} ${(Math.sin(a) * 0.5 + 0.5) * h}`)
  }
  return `M${pts.join('L')}Z`
}
export function starPath(points: number, w: number, h: number, inner = 0.4) {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 0.5 : 0.5 * inner
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    pts.push(`${(Math.cos(a) * r + 0.5) * w} ${(Math.sin(a) * r + 0.5) * h}`)
  }
  return `M${pts.join('L')}Z`
}
