import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { parseFont, textToPath } from '../src/core/text/vectorText'
import { flattenPath, polylineBounds } from '../src/core/geometry/path'

const load = (n: string) => { const b = fs.readFileSync(`node_modules/@fontsource/${n}.woff`); return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) }

describe('vector text', () => {
  const fonts = ['roboto/files/roboto-latin-400-normal', 'oswald/files/oswald-latin-400-normal', 'pacifico/files/pacifico-latin-400-normal', 'playfair-display/files/playfair-display-latin-400-normal']
  for (const f of fonts) it('lays out ' + f, () => {
    const t = textToPath(load(f), 'Hello Ember', 10)
    expect(t.d.length).toBeGreaterThan(50)
    const b = polylineBounds(flattenPath(t.d))!
    expect(b.maxX - b.minX).toBeGreaterThan(20)
    expect(b.maxY - b.minY).toBeGreaterThan(5)
    expect(b.maxY - b.minY).toBeLessThan(14)
    expect(t.widthMm).toBeGreaterThan(20)
  })
  it('multi-line grows height', () => {
    const f = load(fonts[0])
    expect(textToPath(f, 'a\nb', 10).heightMm).toBeCloseTo(24)
  })
})

import { generate } from '../src/core/gcode/generate'
import { FALCON2_22W, defaultLayer } from '../src/core/types'
describe('vector text burns', () => {
  it('contours are closed and a fill layer produces hatch lines with a hole in the O', () => {
    const t = textToPath(load('roboto/files/roboto-latin-400-normal'), 'OH', 20)
    const polys = flattenPath(t.d, 0.05)
    expect(polys.length).toBe(3)
    expect(polys.every((p) => p.closed)).toBe(true)
    polys.forEach((p) => (p.group = 0))
    const layer = { ...defaultLayer('L1', 'E', '#f00'), mode: 'fill' as const, speed: 150, power: 35, lineInterval: 0.2 }
    const r = generate([{ settings: layer, vectors: polys, images: [] }], { machine: FALCON2_22W, origin: { mode: 'bed' }, returnToOrigin: true, constantPower: false })
    expect(r.lines.filter((l) => l.startsWith('G1')).length).toBeGreaterThan(100)
  })
})
