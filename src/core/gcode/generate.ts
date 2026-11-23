import { pointInPolygon, polylineBounds } from '../geometry/path'
import { apply, invert } from '../geometry/matrix'
import { adjustLut, ditherInPlace, sampleBilinear } from '../raster/dither'
import type {
  Anchor,
  GenOptions,
  GenResult,
  LayerJob,
  LayerSettings,
  MachineProfile,
  OriginMode,
  PlacedImage,
  Point,
  Polyline,
  Rect,
} from '../types'

const fmt = (n: number) => {
  const s = n.toFixed(3)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export type Mapper = (x: number, y: number) => [number, number]

export function anchorPoint(b: Rect, a: Anchor): Point {
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  switch (a) {
    case 'bl':
      return { x: b.minX, y: b.maxY }
    case 'br':
      return { x: b.maxX, y: b.maxY }
    case 'tl':
      return { x: b.minX, y: b.minY }
    case 'tr':
      return { x: b.maxX, y: b.minY }
    default:
      return { x: cx, y: cy }
  }
}

/** Design space (mm, y down) to machine space (y up). */
export function makeMapper(machine: MachineProfile, origin: OriginMode, bounds: Rect | null): Mapper {
  if (origin.mode === 'job') {
    const a = bounds ? anchorPoint(bounds, origin.anchor) : { x: 0, y: 0 }
    return (x, y) => [x - a.x, a.y - y]
  }
  const c = machine.originCorner
  return (x, y) => [
    c.endsWith('l') ? x : x - machine.bedWidth,
    c.startsWith('b') ? machine.bedHeight - y : -y,
  ]
}

class Emitter {
  lines: string[] = []
  seconds = 0
  // Where the head is when the job starts is unknown, so the first move is always an explicit G0.
  private mx = NaN
  private my = NaN
  /** Extent of every move in machine coordinates (includes overscan), for the bed check. */
  ext: Rect | null = null
  private f = -1
  private s = -1
  /** Modal motion word in effect, so repeated G1 can be left out (shorter lines stream faster). */
  private motion: 'G0' | 'G1' | null = null
  /** Raster statistics, for the "too many lines per second" check. */
  rasterLines = 0
  rasterSeconds = 0
  constructor(
    private map: Mapper,
    private maxS: number,
    private rapidMmS: number,
  ) {}

  raw(l: string) {
    this.lines.push(l)
    if (/G0*[0-3](?!\d)/i.test(l.replace(/;.*/, ''))) this.motion = null
  }

  private grow(x: number, y: number) {
    const e = this.ext
    if (!e) this.ext = { minX: x, maxX: x, minY: y, maxY: y }
    else (e.minX = Math.min(e.minX, x)), (e.maxX = Math.max(e.maxX, x)), (e.minY = Math.min(e.minY, y)), (e.maxY = Math.max(e.maxY, y))
  }

  rapid(x: number, y: number) {
    const [mx, my] = this.map(x, y)
    if (Math.abs(mx - this.mx) < 5e-4 && Math.abs(my - this.my) < 5e-4) return
    if (Number.isFinite(this.mx)) this.seconds += Math.hypot(mx - this.mx, my - this.my) / this.rapidMmS
    const same = (a: number, b: number) => Number.isFinite(b) && Math.abs(a - b) < 5e-4
    let out = 'G0'
    if (!same(mx, this.mx)) out += ` X${fmt(mx)}`
    if (!same(my, this.my)) out += ` Y${fmt(my)}`
    this.grow(mx, my)
    this.mx = mx
    this.my = my
    this.motion = 'G0'
    this.lines.push(out)
  }

  /** Feed move. speed in mm/s, s is the S word value (already scaled to maxS). */
  line(x: number, y: number, speedMmS: number, s: number) {
    const [mx, my] = this.map(x, y)
    // A feed move must never start from an unknown place: position first with the laser off.
    if (!Number.isFinite(this.mx)) this.rapid(x, y)
    const dist = Math.hypot(mx - this.mx, my - this.my)
    if (dist < 5e-4 && s === this.s) return
    // Only the words that change: GRBL keeps G1, F, S and the other axis modal. Raster rows then cost about half
    // the bytes, which matters because USB serial can only carry ~500 short lines a second.
    const parts: string[] = []
    if (this.motion !== 'G1') parts.push('G1')
    if (Math.abs(mx - this.mx) >= 5e-4 || dist < 5e-4) parts.push(`X${fmt(mx)}`)
    if (Math.abs(my - this.my) >= 5e-4) parts.push(`Y${fmt(my)}`)
    let out = parts.join(' ')
    if (s !== this.s) {
      out += ` S${s}`
      this.s = s
    }
    const f = Math.round(speedMmS * 60)
    if (f !== this.f) {
      out += ` F${f}`
      this.f = f
    }
    this.seconds += dist / speedMmS
    this.grow(mx, my)
    this.mx = mx
    this.my = my
    this.motion = 'G1'
    this.lines.push(out)
  }

  sValue(powerPct: number) {
    return Math.max(0, Math.min(this.maxS, Math.round((powerPct / 100) * this.maxS)))
  }

  get pos(): [number, number] {
    return [this.mx, this.my]
  }
}

export interface Run {
  x0: number
  x1: number
  s: number
}

const GAP_RAPID_MM = 2

/**
 * Burn one scan row. `v` is the fixed coordinate of the row in scan space and runs are along `u`.
 * `toDesign` converts scan space (u, v) back to design space, which lets hatch angles reuse this.
 */
function emitRow(
  em: Emitter,
  v: number,
  runs: Run[],
  forward: boolean,
  speed: number,
  overscan: number,
  toDesign: (u: number, v: number) => [number, number],
) {
  if (!runs.length) return
  const ordered = forward
    ? runs.map((r) => ({ ...r }))
    : runs
        .slice()
        .reverse()
        .map((r) => ({ x0: r.x1, x1: r.x0, s: r.s }))
  const dir = forward ? 1 : -1
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const at = (u: number) => toDesign(u, v)
  let p = at(first.x0 - dir * overscan)
  em.rapid(p[0], p[1])
  if (overscan > 0) {
    p = at(first.x0)
    em.line(p[0], p[1], speed, 0)
  }
  let cursor = first.x0
  for (const r of ordered) {
    const gap = Math.abs(r.x0 - cursor)
    if (gap > 1e-6) {
      p = at(r.x0)
      if (gap > GAP_RAPID_MM) em.rapid(p[0], p[1])
      else em.line(p[0], p[1], speed, 0)
    }
    p = at(r.x1)
    em.line(p[0], p[1], speed, r.s)
    cursor = r.x1
  }
  if (overscan > 0) {
    p = at(last.x1 + dir * overscan)
    em.line(p[0], p[1], speed, 0)
  }
}

function imageBounds(img: PlacedImage): Rect {
  const pts = [
    { x: 0, y: 0 },
    { x: img.widthMm, y: 0 },
    { x: img.widthMm, y: img.heightMm },
    { x: 0, y: img.heightMm },
  ].map((p) => apply(img.matrix, p))
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  }
}

export function jobBounds(jobs: LayerJob[]): Rect | null {
  let r: Rect | null = null
  const add = (b: Rect | null) => {
    if (!b) return
    if (!r) r = { ...b }
    else {
      r.minX = Math.min(r.minX, b.minX)
      r.minY = Math.min(r.minY, b.minY)
      r.maxX = Math.max(r.maxX, b.maxX)
      r.maxY = Math.max(r.maxY, b.maxY)
    }
  }
  for (const j of jobs) {
    if (!j.settings.output) continue
    add(polylineBounds(j.vectors))
    for (const img of j.images) add(imageBounds(img))
  }
  return r
}

function emitRaster(em: Emitter, img: PlacedImage, s: LayerSettings, maxS: number) {
  const inv = invert(img.matrix)
  if (!inv) return
  const b = imageBounds(img)
  const step = Math.max(0.02, s.lineInterval)
  const cols = Math.max(1, Math.floor((b.maxX - b.minX) / step) + 1)
  const rows = Math.max(1, Math.floor((b.maxY - b.minY) / step) + 1)
  const lut = adjustLut(img.adjust)
  const grid = new Uint8Array(cols * rows)
  const sx = img.width / img.widthMm
  const sy = img.height / img.heightMm
  for (let r = 0; r < rows; r++) {
    const y = b.minY + r * step
    for (let c = 0; c < cols; c++) {
      const x = b.minX + c * step
      const l = apply(inv, { x, y })
      grid[r * cols + c] = lut[Math.round(sampleBilinear(img.gray, img.width, img.height, l.x * sx, l.y * sy))]
    }
  }
  const grayscale = s.dither === 'grayscale'
  if (s.dither !== 'grayscale') ditherInPlace(grid, cols, rows, s.dither, s.threshold)
  const full = em.sValue(s.power)
  const low = em.sValue(Math.min(s.minPower, s.power))
  const half = step / 2
  for (let r = 0; r < rows; r++) {
    const y = b.minY + r * step
    const runs: Run[] = []
    let cur: Run | null = null
    for (let c = 0; c < cols; c++) {
      const g = grid[r * cols + c]
      let sv = 0
      if (grayscale) {
        const dark = (255 - g) / 255
        // 32 power levels: plenty for a diode laser, and equal neighbours merge into one longer move.
        if (dark > 0.02) sv = Math.round(low + (full - low) * Math.round(dark * 32) / 32)
      } else if (g === 0) sv = full
      const x0 = b.minX + c * step - half
      const x1 = x0 + step
      if (sv === 0) {
        cur = null
        continue
      }
      if (cur && cur.s === sv && Math.abs(cur.x1 - x0) < 1e-6) cur.x1 = x1
      else {
        cur = { x0, x1, s: sv }
        runs.push(cur)
      }
    }
    const forward = !s.bidirectional || r % 2 === 0
    const l0 = em.lines.length
    const t0 = em.seconds
    emitRow(em, y, runs, forward, s.speed, s.overscan, (u, v) => [u, v])
    em.rasterLines += em.lines.length - l0
    em.rasterSeconds += em.seconds - t0
  }
  void maxS
}

/** Even-odd hatch fill for closed polygons, grouped so each group is its own even-odd set. */
function emitFill(em: Emitter, polys: Polyline[], s: LayerSettings) {
  const closed = polys.filter((p) => p.closed && p.points.length > 2)
  if (!closed.length) return
  const ang = (s.fillAngle * Math.PI) / 180
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  // rotate so hatch lines are horizontal: u = x cos + y sin, v = -x sin + y cos
  const toScan = (p: Point) => ({ x: p.x * ca + p.y * sa, y: -p.x * sa + p.y * ca })
  const toDesign = (u: number, v: number): [number, number] => [u * ca - v * sa, u * sa + v * ca]
  const step = Math.max(0.02, s.lineInterval)
  const rowsMap = new Map<number, Run[]>()
  const groups = new Map<number, Polyline[]>()
  closed.forEach((p, i) => {
    const g = p.group ?? -1 - i
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(p)
  })
  const full = em.sValue(s.power)
  for (const g of groups.values()) {
    const sp = g.map((p) => p.points.map(toScan))
    let minV = Infinity
    let maxV = -Infinity
    for (const pts of sp) for (const p of pts) (minV = Math.min(minV, p.y)), (maxV = Math.max(maxV, p.y))
    const k0 = Math.ceil(minV / step)
    const k1 = Math.floor(maxV / step)
    for (let k = k0; k <= k1; k++) {
      const v = k * step + 1e-7
      const xs: number[] = []
      for (const pts of sp) {
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]
          const b = pts[(i + 1) % pts.length]
          if (a.y > v !== b.y > v) xs.push(a.x + ((v - a.y) / (b.y - a.y)) * (b.x - a.x))
        }
      }
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        if (xs[i + 1] - xs[i] < 1e-4) continue
        if (!rowsMap.has(k)) rowsMap.set(k, [])
        rowsMap.get(k)!.push({ x0: xs[i], x1: xs[i + 1], s: full })
      }
    }
  }
  const keys = [...rowsMap.keys()].sort((a, b) => a - b)
  keys.forEach((k, idx) => {
    const runs = rowsMap.get(k)!.sort((a, b) => a.x0 - b.x0)
    const forward = !s.bidirectional || idx % 2 === 0
    emitRow(em, k * step, runs, forward, s.speed, s.overscan, toDesign)
  })
}

/** How many closed shapes contain each polyline (used to cut holes before outlines). */
function nestingDepth(lines: Polyline[]): number[] {
  const boxes = lines.map((l) => polylineBounds([l])!)
  return lines.map((l, i) => {
    let d = 0
    const p = l.points[0]
    for (let j = 0; j < lines.length; j++) {
      if (i === j || !lines[j].closed) continue
      const b = boxes[j]
      if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue
      if (pointInPolygon(p, lines[j].points)) d++
    }
    return d
  })
}

/** Greedy nearest-neighbour ordering with reversal of open paths and start-vertex rotation of closed ones. */
export function orderPaths(lines: Polyline[], start: Point, innerFirst: boolean): Polyline[] {
  const items = lines.filter((l) => l.points.length > 1)
  const depth = innerFirst && items.length < 3000 ? nestingDepth(items) : items.map(() => 0)
  const maxDepth = Math.max(0, ...depth)
  const result: Polyline[] = []
  let pos = start
  for (let d = maxDepth; d >= 0; d--) {
    const pool = items.filter((_, i) => depth[i] === d)
    while (pool.length) {
      let best = 0
      let bestDist = Infinity
      let bestMode = 0 // 0 as-is, 1 reversed (open), 2 rotated (closed) with idx in bestIdx
      let bestIdx = 0
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i]
        if (l.closed) {
          for (let k = 0; k < l.points.length; k++) {
            const dd = Math.hypot(l.points[k].x - pos.x, l.points[k].y - pos.y)
            if (dd < bestDist) (bestDist = dd), (best = i), (bestMode = 2), (bestIdx = k)
          }
        } else {
          const a = l.points[0]
          const b = l.points[l.points.length - 1]
          const da = Math.hypot(a.x - pos.x, a.y - pos.y)
          const db = Math.hypot(b.x - pos.x, b.y - pos.y)
          if (da < bestDist) (bestDist = da), (best = i), (bestMode = 0)
          if (db < bestDist) (bestDist = db), (best = i), (bestMode = 1)
        }
      }
      const l = pool.splice(best, 1)[0]
      let pts = l.points
      if (bestMode === 1) pts = pts.slice().reverse()
      else if (bestMode === 2) pts = [...pts.slice(bestIdx), ...pts.slice(0, bestIdx)]
      result.push({ points: pts, closed: l.closed, group: l.group })
      pos = l.closed ? pts[0] : pts[pts.length - 1]
    }
  }
  return result
}

function emitVectors(em: Emitter, lines: Polyline[], s: LayerSettings, start: Point) {
  const ordered = orderPaths(lines, start, s.innerFirst)
  const sv = em.sValue(s.power)
  for (const l of ordered) {
    const p0 = l.points[0]
    em.rapid(p0.x, p0.y)
    for (let i = 1; i < l.points.length; i++) em.line(l.points[i].x, l.points[i].y, s.speed, sv)
    if (l.closed) em.line(p0.x, p0.y, s.speed, sv)
  }
}

export function generate(jobs: LayerJob[], opts: GenOptions): GenResult {
  const { machine, origin } = opts
  const warnings: string[] = []
  const active = jobs.filter((j) => j.settings.output && (j.vectors.length || j.images.length))
  const bounds = jobBounds(active)
  const map = makeMapper(machine, origin, bounds)
  const em = new Emitter(map, machine.maxS, machine.rapidSpeed)

  if (!machine.laserMode) warnings.push('Machine profile is not in laser mode ($32=1). Output assumes laser mode.')
  if (!bounds) {
    warnings.push('Nothing to output.')
    return { lines: [], bounds: null, estimateSeconds: 0, warnings }
  }

  em.raw('; Generated by Ember Laser Studio')
  em.raw('G21 G90 G17 G94')
  em.raw(`${opts.constantPower ? 'M3' : 'M4'} S0`)

  for (const job of active) {
    const s = job.settings
    if (s.speed > machine.maxSpeed) {
      warnings.push(`Layer "${s.name}" speed ${s.speed} mm/s exceeds machine max (${machine.maxSpeed}); clamped.`)
    }
    const eff: LayerSettings = { ...s, speed: Math.max(0.1, Math.min(machine.maxSpeed, s.speed)), power: Math.max(0, Math.min(100, s.power)) }
    em.raw(`; layer: ${s.name} (${s.mode}, ${eff.speed} mm/s, ${eff.power}%, ${s.passes} pass${s.passes === 1 ? '' : 'es'})`)
    if (s.airAssist) em.raw('M8')
    for (let pass = 0; pass < Math.max(1, s.passes); pass++) {
      const here = em.pos
      // convert current machine pos back to design for ordering; only used as a hint so approximate is fine
      const hint: Point = { x: bounds.minX, y: bounds.minY }
      void here
      if (job.vectors.length) {
        if (eff.mode === 'fill') emitFill(em, job.vectors, eff)
        else emitVectors(em, job.vectors, eff, hint)
      }
      for (const img of job.images) emitRaster(em, img, eff, machine.maxS)
    }
    if (s.airAssist) em.raw('M9')
  }

  em.raw('M5 S0')
  if (opts.returnToOrigin) em.raw('G0 X0 Y0')

  // GRBL over USB manages roughly 400-600 short lines a second. Asking for more makes the head stutter and
  // over-burn wherever it waits for data.
  if (em.rasterSeconds > 1 && em.rasterLines / em.rasterSeconds > 400)
    warnings.push(`A picture needs about ${Math.round(em.rasterLines / em.rasterSeconds)} G-code lines per second, more than the laser can be fed. Expect stutter and dark marks: lower the speed, or use a dither mode instead of grayscale.`)

  // Check the real tool path (overscan included), not just the artwork: GRBL alarms or hits the frame otherwise.
  const e = em.ext
  if (e) {
    if (origin.mode === 'job') {
      if (e.maxX - e.minX > machine.bedWidth + 1e-6 || e.maxY - e.minY > machine.bedHeight + 1e-6)
        warnings.push('Design is larger than the machine work area.')
    } else {
      const lo = machine.originCorner.endsWith('l') ? 0 : -machine.bedWidth
      const loY = machine.originCorner.startsWith('b') ? 0 : -machine.bedHeight
      const tol = 1e-3
      if (e.minX < lo - tol || e.maxX > lo + machine.bedWidth + tol || e.minY < loY - tol || e.maxY > loY + machine.bedHeight + tol) {
        const art = [map(bounds.minX, bounds.minY), map(bounds.maxX, bounds.maxY)]
        const artOut = Math.min(art[0][0], art[1][0]) < lo - tol || Math.max(art[0][0], art[1][0]) > lo + machine.bedWidth + tol || Math.min(art[0][1], art[1][1]) < loY - tol || Math.max(art[0][1], art[1][1]) > loY + machine.bedHeight + tol
        warnings.push(artOut ? 'Design extends outside the machine work area.' : 'The design is so close to the edge that the laser would run outside the work area while speeding up (overscan). Move it in a little or turn overscan down.')
      }
    }
  }
  const estimate = em.seconds * 1.08
  return { lines: em.lines, bounds, estimateSeconds: estimate, warnings }
}

/** A closed rectangle around the job at low travel speed with the laser off, so the user can check placement. */
export function generateFrame(bounds: Rect, machine: MachineProfile, origin: OriginMode, feedMmS = 100): string[] {
  const map = makeMapper(machine, origin, bounds)
  const pts = [
    map(bounds.minX, bounds.maxY),
    map(bounds.maxX, bounds.maxY),
    map(bounds.maxX, bounds.minY),
    map(bounds.minX, bounds.minY),
    map(bounds.minX, bounds.maxY),
  ]
  const f = Math.round(feedMmS * 60)
  return [
    'G21 G90',
    'M5',
    `G0 X${fmt(pts[0][0])} Y${fmt(pts[0][1])}`,
    ...pts.slice(1).map((p) => `G1 X${fmt(p[0])} Y${fmt(p[1])} S0 F${f}`),
  ]
}

/** Frame for G-code that is already in machine/work coordinates (imported files, material tests): no mapping. */
export function generateFrameRaw(b: Rect, feedMmS = 100): string[] {
  const f = Math.round(feedMmS * 60)
  const pts = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
    [b.minX, b.minY],
  ]
  return ['G21 G90', 'M5', `G0 X${fmt(pts[0][0])} Y${fmt(pts[0][1])}`, ...pts.slice(1).map((p) => `G1 X${fmt(p[0])} Y${fmt(p[1])} S0 F${f}`)]
}

export interface TestGridOptions {
  machine: MachineProfile
  origin: OriginMode
  speeds: number[] // mm/s, one per column
  powers: number[] // %, one per row
  cell: number // mm square size
  gap: number
  lineInterval: number
  /** fill = engrave squares (default), line = cut squares */
  mode?: 'fill' | 'line'
  passes?: number
}

/** Material test: a grid of filled squares, speed varying by column and power by row. */
export function generateTestGrid(o: TestGridOptions): GenResult {
  const jobs: LayerJob[] = []
  o.powers.forEach((power, r) => {
    o.speeds.forEach((speed, c) => {
      const x = c * (o.cell + o.gap)
      const y = r * (o.cell + o.gap)
      jobs.push({
        settings: {
          id: `t${r}-${c}`,
          name: `${Math.round(speed * 60)}mm/min ${power}%`,
          color: '#fff',
          visible: true,
          output: true,
          mode: o.mode ?? 'fill',
          speed,
          power,
          minPower: 0,
          passes: o.passes ?? 1,
          lineInterval: o.lineInterval,
          fillAngle: 0,
          dither: 'threshold',
          threshold: 128,
          bidirectional: true,
          overscan: 1,
          airAssist: false,
          innerFirst: false,
        },
        vectors: [
          {
            closed: true,
            points: [
              { x, y },
              { x: x + o.cell, y },
              { x: x + o.cell, y: y + o.cell },
              { x, y: y + o.cell },
            ],
          },
        ],
        images: [],
      })
    })
  })
  return generate(jobs, { machine: o.machine, origin: o.origin, returnToOrigin: true, constantPower: false })
}
