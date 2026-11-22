import { describe, expect, it } from 'vitest'
import { parsePath, flattenPath, rectPath, ellipsePath, polylineBounds } from '../src/core/geometry/path'
import { invert, multiply, objectMatrix, apply, parseTransform } from '../src/core/geometry/matrix'
import { parseGrblLine } from '../src/core/grbl/protocol'
import { generate, generateFrame, generateTestGrid, orderPaths } from '../src/core/gcode/generate'
import { parseGcode } from '../src/core/gcode/preview'
import { ditherInPlace } from '../src/core/raster/dither'
import { importSvg } from '../src/core/svg/import'
import { compileDoc, newDoc } from '../src/core/document'
import { FALCON2_22W, defaultLayer, type LayerJob, type Polyline } from '../src/core/types'

const opts = { machine: FALCON2_22W, origin: { mode: 'job', anchor: 'bl' } as const, returnToOrigin: false, constantPower: false }
const sq = (x: number, y: number, s: number, closed = true): Polyline => ({
  closed,
  points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }],
})

describe('geometry', () => {
  it('flattens rect and ellipse', () => {
    const r = flattenPath(rectPath(10, 20))
    expect(r).toHaveLength(1)
    expect(r[0].closed).toBe(true)
    expect(polylineBounds(r)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 20 })
    const e = polylineBounds(flattenPath(ellipsePath(30, 10), 0.01))!
    expect(e.maxX).toBeCloseTo(30, 2)
    expect(e.maxY).toBeCloseTo(10, 2)
    expect(e.minX).toBeCloseTo(0, 2)
  })
  it('parses relative commands, H/V and implicit lineto', () => {
    const segs = parsePath('m10 10 20 0 v 5 h-20 z')
    expect(segs.map((s) => s.t)).toEqual(['M', 'L', 'L', 'L', 'Z'])
    expect((segs[3] as any).p).toEqual([10, 15])
  })
  it('matrix invert round-trips', () => {
    const m = objectMatrix(5, 7, 30, 2, 3)
    const inv = invert(m)!
    const p = apply(inv, apply(m, { x: 3, y: 4 }))
    expect(p.x).toBeCloseTo(3)
    expect(p.y).toBeCloseTo(4)
    const t = parseTransform('translate(10 0) scale(2)')
    expect(apply(t, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 })
    expect(multiply([1, 0, 0, 1, 0, 0], t)).toEqual(t)
  })
})

describe('GRBL parser', () => {
  it('parses status reports', () => {
    const e = parseGrblLine('<Run|MPos:10.000,20.500,0.000|Bf:14,120|FS:1500,800|Ov:100,100,100>')
    expect(e?.type).toBe('status')
    if (e?.type === 'status') {
      expect(e.status.state).toBe('Run')
      expect(e.status.mpos).toEqual({ x: 10, y: 20.5, z: 0 })
      expect(e.status.buffer).toEqual({ planner: 14, rx: 120 })
      expect(e.status.feed).toBe(1500)
      expect(e.status.spindle).toBe(800)
    }
  })
  it('parses ok, error, alarm, settings, welcome', () => {
    expect(parseGrblLine('ok')).toEqual({ type: 'ok' })
    expect(parseGrblLine('error:20')).toMatchObject({ type: 'error', code: 20 })
    expect(parseGrblLine('ALARM:1')).toMatchObject({ type: 'alarm', code: 1 })
    expect(parseGrblLine('$32=1')).toEqual({ type: 'setting', id: 32, value: '1' })
    expect(parseGrblLine("Grbl 1.1h ['$' for help]")).toMatchObject({ type: 'welcome', version: '1.1h' })
  })
})

describe('G-code generation', () => {
  const layer = { ...defaultLayer('a', 'Cut', '#f00'), speed: 10, power: 50, passes: 1 }
  it('outputs a cut with job-origin mapping (bottom-left = 0,0, y up)', () => {
    const job: LayerJob = { settings: layer, vectors: [sq(100, 100, 20)], images: [] }
    const r = generate([job], opts)
    expect(r.lines[1]).toBe('G21 G90 G17 G94')
    expect(r.lines[2]).toBe('M4 S0')
    const g = parseGcode(r.lines)
    expect(g.bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 })
    expect(g.maxS).toBe(500)
    expect(r.lines.some((l) => l.includes('F600'))).toBe(true)
    expect(r.lines.at(-1)).toBe('M5 S0')
    expect(r.estimateSeconds).toBeGreaterThan(8)
  })
  it('repeats for passes', () => {
    const one = generate([{ settings: layer, vectors: [sq(0, 0, 10)], images: [] }], opts)
    const three = generate([{ settings: { ...layer, passes: 3 }, vectors: [sq(0, 0, 10)], images: [] }], opts)
    expect(parseGcode(three.lines).moves.filter((m) => m.s > 0).length).toBe(3 * parseGcode(one.lines).moves.filter((m) => m.s > 0).length)
  })
  it('cuts inner shapes first', () => {
    const outer = sq(0, 0, 50)
    const inner = sq(10, 10, 10)
    const ordered = orderPaths([outer, inner], { x: 0, y: 0 }, true)
    expect(ordered[0].points.some((p) => p.x === 20)).toBe(true) // inner first
  })
  it('bed origin maps bottom-left corner design coords to machine coords', () => {
    const job: LayerJob = { settings: layer, vectors: [sq(0, 415 - 10, 10)], images: [] }
    const r = generate([job], { ...opts, origin: { mode: 'bed' } })
    expect(parseGcode(r.lines).bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
    expect(r.warnings).toHaveLength(0)
  })
  it('warns when design is off the bed, and clamps speed', () => {
    const job: LayerJob = { settings: { ...layer, speed: 9999 }, vectors: [sq(0, 0, 500)], images: [] }
    const r = generate([job], opts)
    expect(r.warnings.join(' ')).toMatch(/larger than/)
    expect(r.warnings.join(' ')).toMatch(/clamped/)
    expect(r.lines.some((l) => l.includes(`F${FALCON2_22W.maxSpeed * 60}`))).toBe(true)
  })
  it('hatch-fills a square with the right line count, bidirectionally', () => {
    const fill = { ...layer, mode: 'fill' as const, lineInterval: 0.5, overscan: 0, speed: 100 }
    const r = generate([{ settings: fill, vectors: [sq(0, 0, 10)], images: [] }], opts)
    const burns = parseGcode(r.lines).moves.filter((m) => m.s > 0)
    expect(burns.length).toBeGreaterThanOrEqual(20)
    expect(burns.length).toBeLessThanOrEqual(22)
    const dirs = burns.slice(0, 4).map((m) => Math.sign(m.x1 - m.x0))
    expect(dirs[0]).toBe(-dirs[1])
  })
  it('keeps holes (even-odd) when shapes share a group', () => {
    const fill = { ...layer, mode: 'fill' as const, lineInterval: 1, overscan: 0 }
    const outer = { ...sq(0, 0, 10), group: 1 }
    const hole = { ...sq(3, 3, 4), group: 1 }
    const r = generate([{ settings: fill, vectors: [outer, hole], images: [] }], opts)
    const mid = parseGcode(r.lines).moves.filter((m) => m.s > 0 && Math.abs(m.y0 - 5) < 0.6)
    // the row through the middle must be split in two pieces, not one 10mm run
    expect(mid.every((m) => Math.abs(m.x1 - m.x0) < 5)).toBe(true)
    expect(mid.length).toBeGreaterThanOrEqual(2)
  })
  it('engraves a raster image and respects S limits', () => {
    const w = 20
    const h = 20
    const gray = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) gray[y * w + x] = 0 // left half black
    const l = { ...layer, mode: 'fill' as const, lineInterval: 0.5, dither: 'threshold' as const, overscan: 0, power: 40 }
    const img = { width: w, height: h, gray, widthMm: 10, heightMm: 10, matrix: [1, 0, 0, 1, 0, 0] as any }
    const r = generate([{ settings: l, vectors: [], images: [img] }], opts)
    const g = parseGcode(r.lines)
    expect(g.maxS).toBe(400)
    expect(g.bounds!.maxX).toBeLessThanOrEqual(5.3)
    expect(g.bounds!.minX).toBeGreaterThanOrEqual(-0.3)
    for (const line of r.lines) {
      const s = /S(\d+)/.exec(line)
      if (s) expect(Number(s[1])).toBeLessThanOrEqual(FALCON2_22W.maxS)
    }
  })
  it('grayscale mode varies S', () => {
    const w = 16
    const gray = new Uint8Array(w)
    for (let i = 0; i < w; i++) gray[i] = Math.round((i / (w - 1)) * 255)
    const l = { ...layer, mode: 'fill' as const, lineInterval: 1, dither: 'grayscale' as const, overscan: 0, power: 100, minPower: 0 }
    const img = { width: w, height: 1, gray, widthMm: 16, heightMm: 1, matrix: [1, 0, 0, 1, 0, 0] as any }
    const r = generate([{ settings: l, vectors: [], images: [img] }], opts)
    const ss = new Set(r.lines.map((x) => /S(\d+)/.exec(x)?.[1]).filter(Boolean))
    expect(ss.size).toBeGreaterThan(5)
  })
  it('frame is a closed laser-off rectangle', () => {
    const f = generateFrame({ minX: 0, minY: 0, maxX: 30, maxY: 20 }, FALCON2_22W, opts.origin)
    expect(f).toContain('M5')
    expect(f.filter((x) => x.startsWith('G1')).every((x) => x.includes('S0'))).toBe(true)
    expect(f.length).toBe(7)
  })
  it('test grid has one square per cell', () => {
    const r = generateTestGrid({ machine: FALCON2_22W, origin: opts.origin, speeds: [100, 200, 300], powers: [10, 20], cell: 5, gap: 2, lineInterval: 0.5 })
    expect(r.warnings).toHaveLength(0)
    expect(r.lines.filter((l) => l.startsWith('; layer')).length).toBe(6)
  })
})

describe('dither', () => {
  const ramp = () => {
    const g = new Uint8Array(64 * 8)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) g[y * 64 + x] = Math.round((x / 63) * 255)
    return g
  }
  for (const mode of ['threshold', 'floyd', 'atkinson', 'bayer'] as const) {
    it(`${mode} outputs only 0/255`, () => {
      const g = ramp()
      ditherInPlace(g, 64, 8, mode)
      expect(g.every((v) => v === 0 || v === 255)).toBe(true)
    })
  }
  it('error diffusion preserves average tone', () => {
    const g = new Uint8Array(100 * 100).fill(128)
    ditherInPlace(g, 100, 100, 'floyd', 128)
    const white = g.filter((v) => v === 255).length / g.length
    expect(white).toBeGreaterThan(0.4)
    expect(white).toBeLessThan(0.6)
  })
})

describe('SVG import', () => {
  it('applies viewBox scale, mm units and transforms', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 10 5">
      <g transform="translate(1 1)"><rect x="0" y="0" width="2" height="1" stroke="#f00" fill="none"/></g>
      <circle cx="5" cy="2.5" r="1" fill="blue"/></svg>`
    const r = importSvg(svg)
    expect(r.widthMm).toBeCloseTo(100)
    expect(r.shapes).toHaveLength(2)
    expect(r.shapes[0].color).toBe('#ff0000')
    const b = polylineBounds(flattenPath(r.shapes[0].d))!
    expect(b.minX).toBeCloseTo(10)
    expect(b.maxX).toBeCloseTo(30)
    expect(r.shapes[1].filled).toBe(true)
    expect(r.shapes[1].color).toBe('#0000ff')
  })
  it('rejects non-SVG', () => {
    expect(() => importSvg('<html/>')).toThrow()
  })
})

describe('document compile', () => {
  it('compiles paths with object transforms into the right layer', () => {
    const doc = newDoc('x')
    doc.objects.push({ id: 'o1', name: 'r', layerId: 'L2', type: 'path', shape: 'rect', d: rectPath(10, 10), x: 50, y: 60, rotation: 0, scaleX: 2, scaleY: 1 })
    const jobs = compileDoc(doc, { image: () => undefined, text: () => undefined })
    expect(jobs[0].vectors).toHaveLength(0)
    expect(polylineBounds(jobs[1].vectors)).toEqual({ minX: 50, minY: 60, maxX: 70, maxY: 70 })
  })
})
