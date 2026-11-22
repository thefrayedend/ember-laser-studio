/**
 * Resume a job part-way through.
 *
 * Replays the G-code before the chosen line to learn the modal state (position, feed, power,
 * spindle mode, coolant, work coordinate system), then builds a safe preamble: laser off,
 * rapid to where the line begins, restore the state, continue.
 */

export interface Modal {
  x: number
  y: number
  rel: boolean
  motion: 0 | 1 | 2 | 3
  f: number
  s: number
  spindle: 'M3' | 'M4' | 'off'
  coolant: 'M7' | 'M8' | 'off'
  wcs: number // 54..59
}

export const initialModal = (): Modal => ({ x: 0, y: 0, rel: false, motion: 0, f: 0, s: 0, spindle: 'off', coolant: 'off', wcs: 54 })

const clean = (raw: string) => raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').toUpperCase().trim()

interface Step {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Advance the modal state through one line. Returns the XY segment travelled, if any. */
export function step(m: Modal, raw: string): Step | null {
  const l = clean(raw)
  if (!l || l.startsWith('$')) return null
  const w: Record<string, number[]> = {}
  const re = /([A-Z])\s*(-?\d*\.?\d+)/g
  let k: RegExpExecArray | null
  while ((k = re.exec(l))) (w[k[1]] ??= []).push(Number(k[2]))
  const g = w.G ?? []
  for (const c of g) {
    if (c === 90) m.rel = false
    else if (c === 91) m.rel = true
    else if (c >= 54 && c <= 59) m.wcs = c
    else if (c === 0 || c === 1 || c === 2 || c === 3) m.motion = c
  }
  for (const c of w.M ?? []) {
    if (c === 3) m.spindle = 'M3'
    else if (c === 4) m.spindle = 'M4'
    else if (c === 5) m.spindle = 'off'
    else if (c === 7) m.coolant = 'M7'
    else if (c === 8) m.coolant = 'M8'
    else if (c === 9) m.coolant = 'off'
  }
  if (w.F) m.f = w.F[0]
  if (w.S) m.s = w.S[0]
  // These commands use axis words for something other than a move.
  if (g.some((c) => c === 10 || c === 92 || c === 53 || c === 28 || c === 30)) return null
  if (!w.X && !w.Y) return null
  const x1 = w.X ? (m.rel ? m.x + w.X[0] : w.X[0]) : m.x
  const y1 = w.Y ? (m.rel ? m.y + w.Y[0] : w.Y[0]) : m.y
  const s: Step = { x0: m.x, y0: m.y, x1, y1 }
  m.x = x1
  m.y = y1
  return s
}

export function modalBefore(lines: string[], index: number): Modal {
  const m = initialModal()
  for (let i = 0; i < index && i < lines.length; i++) step(m, lines[i])
  return m
}

const f3 = (n: number) => String(Math.round(n * 1000) / 1000)

/** Lines that safely restart the job at `from` (index into `lines`). */
export function buildResume(lines: string[], from: number): string[] {
  const m = modalBefore(lines, from)
  const out: string[] = ['G21', 'G90', 'G17', `G${m.wcs}`, 'M5']
  if (m.coolant !== 'off') out.push(m.coolant)
  out.push(`G0 X${f3(m.x)} Y${f3(m.y)}`)
  if (m.rel) out.push('G91')
  const tail = lines.slice(from)
  if (m.motion === 1) out.push(m.f ? `G1 F${f3(m.f)}` : 'G1')
  else if (m.f) out.push(`F${f3(m.f)}`)
  if (m.spindle === 'M4') out.push(`M4 S${f3(m.s)}`)
  else if (m.spindle === 'M3') {
    // M3 with power and no motion would fire the laser in place, so start at S0 and
    // give the first cutting move its power word.
    out.push('M3 S0')
    const probe = { ...m }
    for (let i = 0; i < tail.length; i++) {
      const c = clean(tail[i])
      const hasS = /S\s*-?\d/.test(c)
      const mv = step(probe, tail[i])
      if (hasS) break
      if (mv && probe.motion === 1) {
        tail[i] = `${tail[i].replace(/;.*/, '').trimEnd()} S${f3(m.s)}`
        break
      }
    }
  }
  return [...out, ...tail]
}

const segDist = (px: number, py: number, s: Step) => {
  const dx = s.x1 - s.x0
  const dy = s.y1 - s.y0
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - s.x0) * dx + (py - s.y0) * dy) / len2)) : 0
  return Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy))
}

/**
 * Best guess for where a stopped job got to: the line in [lo, hi] whose path passes
 * closest to the position the head was left at. Returns a line index to resume from.
 */
export function findResumeLine(lines: string[], pos: { x: number; y: number }, lo: number, hi: number): number {
  const m = initialModal()
  let best = Math.max(0, lo)
  let bestD = Infinity
  for (let i = 0; i < lines.length && i <= hi; i++) {
    const s = step(m, lines[i])
    if (i < lo || !s) continue
    const d = segDist(pos.x, pos.y, s)
    if (d <= bestD + 1e-9) {
      bestD = d
      best = i
    }
  }
  return best
}
