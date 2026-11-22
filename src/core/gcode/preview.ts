import type { Rect } from '../types'

export interface Move {
  x0: number
  y0: number
  x1: number
  y1: number
  /** S word in effect while moving, 0 for travel/off */
  s: number
  rapid: boolean
  /** index of the source line */
  line: number
}

export interface ParsedGcode {
  moves: Move[]
  bounds: Rect | null
  /** Seconds, from feed rates and distances only */
  estimateSeconds: number
  maxS: number
}

/** Light G-code reader for previews and time estimates. Handles G0/G1, G90/G91, M3/M4/M5 and modal F/S. */
export function parseGcode(lines: string[], rapidMmMin = 12000): ParsedGcode {
  const moves: Move[] = []
  let x = 0
  let y = 0
  let rel = false
  let motion = 0
  let f = 1000
  let s = 0
  let spindle: 'off' | 'M3' | 'M4' = 'off'
  let seconds = 0
  let maxS = 0
  let bounds: Rect | null = null
  const grow = (px: number, py: number) => {
    if (!bounds) bounds = { minX: px, minY: py, maxX: px, maxY: py }
    else {
      if (px < bounds.minX) bounds.minX = px
      if (py < bounds.minY) bounds.minY = py
      if (px > bounds.maxX) bounds.maxX = px
      if (py > bounds.maxY) bounds.maxY = py
    }
  }
  lines.forEach((raw, idx) => {
    const l = raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').toUpperCase()
    if (!l.trim() || l.startsWith('$')) return
    const w: Record<string, number[]> = {}
    const re = /([A-Z])\s*(-?\d*\.?\d+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(l))) (w[m[1]] ??= []).push(Number(m[2]))
    const g = w.G ?? []
    const mm = w.M ?? []
    if (g.includes(90)) rel = false
    if (g.includes(91)) rel = true
    if (g.includes(0)) motion = 0
    if (g.includes(1)) motion = 1
    if (w.F) f = w.F[0]
    if (w.S) s = w.S[0]
    for (const c of mm) spindle = c === 3 ? 'M3' : c === 4 ? 'M4' : c === 5 ? 'off' : spindle
    if (g.includes(4) && w.P) seconds += w.P[0]
    if (w.X || w.Y) {
      const nx = w.X ? (rel ? x + w.X[0] : w.X[0]) : x
      const ny = w.Y ? (rel ? y + w.Y[0] : w.Y[0]) : y
      const rapid = motion === 0
      const power = !rapid && spindle !== 'off' ? s : 0
      const dist = Math.hypot(nx - x, ny - y)
      if (dist > 0) {
        moves.push({ x0: x, y0: y, x1: nx, y1: ny, s: power, rapid, line: idx })
        seconds += dist / ((rapid ? rapidMmMin : Math.max(1, f)) / 60)
        if (power > 0) {
          grow(x, y)
          grow(nx, ny)
          maxS = Math.max(maxS, power)
        }
      }
      x = nx
      y = ny
    }
  })
  return { moves, bounds, estimateSeconds: seconds, maxS }
}
