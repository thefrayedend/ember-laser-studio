import type { Matrix, Point } from '../types'

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** Returns a * b, meaning b is applied first, then a. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scale = (sx: number, sy: number = sx): Matrix => [sx, 0, 0, sy, 0, 0]
export function rotate(deg: number): Matrix {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return null
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/** Matrix for an object placed like Konva does: translate, then rotate, then scale. */
export function objectMatrix(x: number, y: number, rotationDeg: number, sx: number, sy: number): Matrix {
  return multiply(multiply(translate(x, y), rotate(rotationDeg)), scale(sx, sy))
}

/** Parse an SVG transform attribute such as "translate(10 5) rotate(45)". */
export function parseTransform(str: string | undefined): Matrix {
  if (!str) return IDENTITY
  let m: Matrix = IDENTITY
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(str))) {
    const args = match[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    let t: Matrix = IDENTITY
    switch (match[1]) {
      case 'matrix':
        if (args.length === 6) t = args as Matrix
        break
      case 'translate':
        t = translate(args[0] ?? 0, args[1] ?? 0)
        break
      case 'scale':
        t = scale(args[0] ?? 1, args[1] ?? args[0] ?? 1)
        break
      case 'rotate':
        if (args.length >= 3) {
          t = multiply(multiply(translate(args[1], args[2]), rotate(args[0])), translate(-args[1], -args[2]))
        } else {
          t = rotate(args[0] ?? 0)
        }
        break
      case 'skewX':
        t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
        break
      case 'skewY':
        t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
        break
    }
    m = multiply(m, t)
  }
  return m
}
