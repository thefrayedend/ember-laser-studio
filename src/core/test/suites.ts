import { generate } from '../gcode/generate'
import { translate } from '../geometry/matrix'
import type { DitherMode, GenResult, LayerJob, LayerSettings, MachineProfile, OriginMode, Polyline } from '../types'

export type TestId = 'engrave' | 'cut' | 'focus' | 'spacing' | 'passes' | 'photo' | 'detail' | 'kerf' | 'marking' | 'air'

export interface CellInfo {
  text: string
  settings: Partial<LayerSettings>
}

export interface TestGridInfo {
  cols: number
  rows: number
  cell: number
  gap: number
  /** index = r * cols + c, r = 0 is the bottom row, c = 0 is the left column */
  cells: CellInfo[]
}

export interface TestInput {
  machine: MachineProfile
  origin: OriginMode
  /** mm/s, used by single-setting tests and as the column list of speed x power grids */
  speed: number
  power: number
  speeds: number[]
  powers: number[]
  thickness: number
}

export interface BuiltTest {
  id: TestId
  title: string
  /** which kind of preset a chosen square becomes */
  kind: 'engrave' | 'cut'
  result: GenResult
  /** what to do and what to look for */
  note: string
  /** present for tests where each square can be scored and turned into a preset */
  grid?: TestGridInfo
  /** present for tests judged by eye: what to write down after looking */
  prompt?: string
}

export interface TestMeta {
  id: TestId
  label: string
  blurb: string
  fields: ('speeds' | 'powers' | 'speed' | 'power' | 'thickness')[]
}

export const TESTS: TestMeta[] = [
  { id: 'engrave', label: 'Engraving: speed × power', blurb: 'Filled squares. Speed changes across, power changes up. The main test for any new material.', fields: ['speeds', 'powers'] },
  { id: 'cut', label: 'Cutting: speed × power', blurb: 'Outlined squares. Find the settings that just cut all the way through.', fields: ['speeds', 'powers'] },
  { id: 'focus', label: 'Focus', blurb: 'Lines burned across a tilted board. The thinnest, darkest line shows the best focus height.', fields: ['speed', 'power'] },
  { id: 'spacing', label: 'Line spacing', blurb: 'The same square at six line spacings. Too tight over-burns, too wide leaves stripes.', fields: ['speed', 'power'] },
  { id: 'passes', label: 'Passes', blurb: 'The same cut done 1 to 4 times. Several fast passes often beat one slow one on thick wood.', fields: ['speed', 'power'] },
  { id: 'photo', label: 'Photo / dither', blurb: 'A gradient and a ball burned with each dither method, to see which suits your material.', fields: ['speed', 'power'] },
  { id: 'detail', label: 'Fine detail', blurb: 'Tiny squares, holes and narrow gaps, to find the smallest detail that comes out cleanly.', fields: ['speed', 'power'] },
  { id: 'kerf', label: 'Kerf and fit', blurb: 'Slots of slightly different widths. Find the one your material fits in snugly.', fields: ['speed', 'power', 'thickness'] },
  { id: 'marking', label: 'Light marking / scoring', blurb: 'Single lines at low power, for scored fold lines and light marks.', fields: ['speeds', 'powers'] },
  { id: 'air', label: 'Air assist on / off', blurb: 'The same squares with air assist off (left) and on (right).', fields: ['speeds', 'powers'] },
]

const base = (name: string, o: Partial<LayerSettings>): LayerSettings => ({
  id: name,
  name,
  color: '#fff',
  visible: true,
  output: true,
  mode: 'fill',
  speed: 66,
  power: 40,
  minPower: 0,
  passes: 1,
  lineInterval: 0.1,
  fillAngle: 0,
  dither: 'threshold',
  threshold: 128,
  bidirectional: true,
  overscan: 1,
  airAssist: false,
  innerFirst: false,
  ...o,
})

const rect = (x: number, y: number, w: number, h: number): Polyline => ({
  closed: true,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
})
const circle = (cx: number, cy: number, r: number): Polyline => ({
  closed: true,
  points: Array.from({ length: 48 }, (_, i) => ({ x: cx + r * Math.cos((i / 48) * 2 * Math.PI), y: cy + r * Math.sin((i / 48) * 2 * Math.PI) })),
})
const seg = (x0: number, y0: number, x1: number, y1: number): Polyline => ({ closed: false, points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] })
const job = (s: LayerSettings, vectors: Polyline[]): LayerJob => ({ settings: s, vectors, images: [] })

const fmtN = (v: number) => String(Math.round(v * 100) / 100)

/** A grid of squares; cell (c, r) uses cellOf(c, r). Row 0 is the BOTTOM row, so the design's y is flipped. */
function squares(cols: number, rows: number, cell: number, gap: number, mode: 'fill' | 'line', cellOf: (c: number, r: number) => CellInfo) {
  const jobs: LayerJob[] = []
  const cells: CellInfo[] = []
  for (let r = rows - 1; r >= 0; r--)
    for (let c = 0; c < cols; c++) {
      const info = cellOf(c, r)
      cells[r * cols + c] = info
      jobs.push(job(base(`r${r}c${c}`, { mode, ...info.settings }), [rect(c * (cell + gap), (rows - 1 - r) * (cell + gap), cell, cell)]))
    }
  return { jobs, grid: { cols, rows, cell, gap, cells } as TestGridInfo }
}

function photoImage(): { gray: Uint8Array; w: number; h: number } {
  const w = 80
  const h = 80
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (y < 30) gray[y * w + x] = Math.round((x / (w - 1)) * 255) // light to dark ramp, shown as white to black
      else {
        const d = Math.hypot(x - w / 2, y - 55) / 22 // a shaded ball
        gray[y * w + x] = d > 1 ? 255 : Math.round(255 - (1 - d * d) * 230)
      }
    }
  return { gray, w, h }
}

export function buildTest(id: TestId, i: TestInput): BuiltTest {
  const gen = (jobs: LayerJob[]) => generate(jobs, { machine: i.machine, origin: i.origin, returnToOrigin: true, constantPower: false })
  const sp = i.speed
  const pw = i.power
  switch (id) {
    case 'engrave':
    case 'cut': {
      const cut = id === 'cut'
      const g = squares(i.speeds.length, i.powers.length, cut ? 10 : 8, cut ? 4 : 2, cut ? 'line' : 'fill', (c, r) => ({
        text: `${fmtN(i.speeds[c] * 60)} mm/min at ${i.powers[r]}%`,
        settings: { speed: i.speeds[c], power: i.powers[r] },
      }))
      return { id, title: cut ? 'Cutting test' : 'Engraving test', kind: cut ? 'cut' : 'engrave', result: gen(g.jobs), grid: g.grid, note: `Speed changes left to right, power changes bottom to top. Burn it on scrap, then pick the square that looks best.` }
    }
    case 'spacing': {
      const iv = [0.05, 0.07, 0.1, 0.12, 0.15, 0.2]
      const g = squares(iv.length, 1, 8, 2, 'fill', (c) => ({ text: `${iv[c]} mm spacing`, settings: { speed: sp, power: pw, lineInterval: iv[c] } }))
      return { id, title: 'Line spacing test', kind: 'engrave', result: gen(g.jobs), grid: g.grid, note: `Left to right: ${iv.join(', ')} mm between lines. Pick the widest spacing that still looks solid (it burns faster and cleaner).` }
    }
    case 'passes': {
      const g = squares(4, 1, 10, 4, 'line', (c) => ({ text: `${c + 1} pass${c ? 'es' : ''}`, settings: { speed: sp, power: pw, passes: c + 1 } }))
      return { id, title: 'Passes test', kind: 'cut', result: gen(g.jobs), grid: g.grid, note: 'Left to right: 1, 2, 3 and 4 passes. Don\'t move the material. Pick the fewest passes that drop the square out cleanly.' }
    }
    case 'air': {
      const n = i.speeds.length
      const g = squares(n * 2, i.powers.length, 8, 2, 'fill', (c, r) => {
        const on = c >= n
        return { text: `${fmtN(i.speeds[c % n] * 60)} mm/min at ${i.powers[r]}%, air ${on ? 'on' : 'off'}`, settings: { speed: i.speeds[c % n], power: i.powers[r], airAssist: on } }
      })
      return { id, title: 'Air assist test', kind: 'engrave', result: gen(g.jobs), grid: g.grid, note: `Left half: air assist off. Right half: on, same speeds and powers. Compare how clean the edges are and how much smoke staining there is.` }
    }
    case 'focus': {
      const jobs: LayerJob[] = []
      const lines: Polyline[] = []
      for (let k = 0; k < 15; k++) lines.push(seg(k % 5 === 0 ? -6 : 0, k * 3, 40, k * 3))
      jobs.push(job(base('focus', { mode: 'line', speed: sp, power: pw }), lines))
      return {
        id, title: 'Focus test', kind: 'engrave', result: gen(jobs),
        note: 'Prop the board on a ramp so the 15 lines (3 mm apart) sit at steadily different heights across about 15 mm of rise: the lowest line is at the bottom of the picture. The longer starts mark lines 1, 6 and 11 counted from the top. The thinnest, crispest line is in focus.',
        prompt: 'Which line was sharpest (1 to 15 counted from the top), and what was the height there?',
      }
    }
    case 'detail': {
      const jobs: LayerJob[] = []
      const sizes = [0.5, 1, 1.5, 2, 3, 4]
      const sq: Polyline[] = []
      let x = 0
      for (const s of sizes) (sq.push(rect(x, 0, s, s)), (x += s + 3))
      jobs.push(job(base('squares', { mode: 'fill', speed: sp, power: pw }), sq))
      const holes: Polyline[] = []
      x = 0
      for (const d of [1, 2, 3, 4, 5]) (holes.push(circle(x + d / 2, 12 + 3, d / 2)), (x += d + 3))
      jobs.push(job(base('holes', { mode: 'line', speed: sp, power: Math.min(100, pw + 20) }), holes))
      const bars: Polyline[] = []
      x = 0
      for (const g of [0.2, 0.3, 0.5, 0.8, 1.2]) {
        bars.push(rect(x, 22, 1, 8), rect(x + 1 + g, 22, 1, 8))
        x += 2 + g + 3
      }
      jobs.push(job(base('bars', { mode: 'fill', speed: sp, power: pw }), bars))
      return {
        id, title: 'Fine detail test', kind: 'engrave', result: gen(jobs),
        note: 'Top row: solid squares from 0.5 to 4 mm. Middle: circles to cut, 1 to 5 mm. Bottom: pairs of 1 mm bars with gaps of 0.2, 0.3, 0.5, 0.8 and 1.2 mm. The smallest square that holds its shape, the smallest hole that opens and the narrowest gap that stays clear are your detail limits.',
        prompt: 'Smallest square / hole / gap that came out well (mm)?',
      }
    }
    case 'kerf': {
      const t = i.thickness
      const jobs: LayerJob[] = []
      const slots: Polyline[] = []
      const widths = Array.from({ length: 9 }, (_, k) => Math.round((t - 0.2 + k * 0.05) * 100) / 100)
      widths.forEach((w, k) => slots.push(rect(4 + k * 8, 6, w, 14)))
      const outer = rect(0, 0, 4 + 8 * 8 + 4 + 6, 26)
      jobs.push(job(base('slots', { mode: 'line', speed: sp, power: pw, innerFirst: true }), [...slots, outer]))
      return {
        id, title: 'Kerf and fit test', kind: 'cut', result: gen(jobs),
        note: `Nine slots from ${widths[0]} to ${widths[8]} mm in ${widths[1] - widths[0]} mm steps, left to right, inside one plate. Push a scrap of your ${t} mm material into each. The first one it enters snugly is your slot width.`,
        prompt: 'Which slot width (mm) gave the snug fit?',
      }
    }
    case 'marking': {
      const jobs: LayerJob[] = []
      i.powers.forEach((p, r) =>
        i.speeds.forEach((s, c) => jobs.push(job(base(`m${r}-${c}`, { mode: 'line', speed: s, power: p }), [seg(c * 16, (i.powers.length - 1 - r) * 4, c * 16 + 12, (i.powers.length - 1 - r) * 4)]))),
      )
      return {
        id, title: 'Light marking test', kind: 'engrave', result: gen(jobs),
        note: `Single lines. Speed changes left to right (${i.speeds.map((v) => fmtN(v * 60)).join(', ')} mm/min), power changes bottom to top (${i.powers.join(', ')}%). Pick the faintest line you still like for fold lines or marks.`,
        prompt: 'Which speed and power gave the line you want?',
      }
    }
    case 'photo': {
      const im = photoImage()
      const modes: DitherMode[] = ['threshold', 'floyd', 'atkinson', 'bayer', 'grayscale']
      const jobs: LayerJob[] = modes.map((m, k) => ({
        settings: base(`dither-${m}`, { speed: sp, power: pw, minPower: m === 'grayscale' ? 10 : 0, dither: m }),
        vectors: [],
        images: [{ width: im.w, height: im.h, gray: im.gray, widthMm: 24, heightMm: 24, matrix: translate(k * 28, 0), adjust: undefined }],
      }))
      return {
        id, title: 'Photo / dither test', kind: 'engrave', result: gen(jobs),
        note: 'Left to right: threshold, Floyd-Steinberg, Atkinson, ordered (Bayer) and grayscale. Each shows a light-to-dark ramp over a shaded ball. Pick the one with the smoothest tones.',
        prompt: 'Which method looked best on this material?',
      }
    }
  }
}
