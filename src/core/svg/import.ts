import { XMLParser } from 'fast-xml-parser'
import { IDENTITY, multiply, parseTransform, scale } from '../geometry/matrix'
import { parsePath, serializePath, transformSegs } from '../geometry/path'
import type { Matrix } from '../types'

export interface ImportedShape {
  /** Path data in mm, transforms already applied. */
  d: string
  /** Stroke colour if stroked, otherwise fill colour. Lower-case hex or the original string. */
  color: string
  /** True when the shape had a fill but no stroke. */
  filled: boolean
}

export interface ImportedSvg {
  shapes: ImportedShape[]
  widthMm: number
  heightMm: number
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
}

function normColor(c: string): string {
  const s = c.trim().toLowerCase()
  if (NAMED[s]) return NAMED[s]
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const rgb = /^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s)
  if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  return s
}

const UNIT: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 }

function lengthMm(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v)
  if (!m || m[2] === '%') return null
  const u = UNIT[m[2].toLowerCase()]
  return u === undefined ? null : Number(m[1]) * u
}

type Attrs = Record<string, string>
interface XNode {
  tag: string
  attrs: Attrs
  children: XNode[]
}

function toTree(items: unknown[]): XNode[] {
  const out: XNode[] = []
  for (const it of items as Record<string, unknown>[]) {
    for (const key of Object.keys(it)) {
      if (key === ':@' || key === '#text') continue
      const attrs: Attrs = {}
      const raw = (it[':@'] ?? {}) as Record<string, string>
      for (const k of Object.keys(raw)) attrs[k.replace(/^@_/, '')] = String(raw[k])
      out.push({ tag: key.toLowerCase(), attrs, children: toTree((it[key] as unknown[]) ?? []) })
    }
  }
  return out
}

function style(attrs: Attrs): Attrs {
  const out: Attrs = { ...attrs }
  if (attrs.style) {
    for (const part of attrs.style.split(';')) {
      const i = part.indexOf(':')
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
  }
  return out
}

function shapeToPath(n: XNode): string | null {
  const a = n.attrs
  const num = (k: string) => Number(a[k] ?? 0)
  switch (n.tag) {
    case 'path':
      return a.d ?? null
    case 'rect': {
      const x = num('x')
      const y = num('y')
      const w = num('width')
      const h = num('height')
      let rx = a.rx !== undefined ? num('rx') : a.ry !== undefined ? num('ry') : 0
      let ry = a.ry !== undefined ? num('ry') : rx
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (!(w > 0 && h > 0)) return null
      if (rx > 0 && ry > 0)
        return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
    }
    case 'circle':
    case 'ellipse': {
      const cx = num('cx')
      const cy = num('cy')
      const rx = n.tag === 'circle' ? num('r') : num('rx')
      const ry = n.tag === 'circle' ? num('r') : num('ry')
      if (!(rx > 0 && ry > 0)) return null
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`
    }
    case 'line':
      return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`
    case 'polyline':
    case 'polygon': {
      const nums = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
      if (nums.length < 4) return null
      let d = `M${nums[0]} ${nums[1]}`
      for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`
      return n.tag === 'polygon' ? d + 'Z' : d
    }
  }
  return null
}

export function importSvg(svgText: string): ImportedSvg {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true })
  const tree = toTree(parser.parse(svgText))
  const root = tree.find((n) => n.tag === 'svg')
  if (!root) throw new Error('Not an SVG file.')

  const vb = (root.attrs.viewBox ?? '').split(/[\s,]+/).map(Number)
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0
  const wAttr = lengthMm(root.attrs.width)
  const hAttr = lengthMm(root.attrs.height)
  let base: Matrix
  let widthMm: number
  let heightMm: number
  if (hasVb) {
    const sx = wAttr !== null ? wAttr / vb[2] : UNIT.px
    const sy = hAttr !== null ? hAttr / vb[3] : wAttr !== null ? sx : UNIT.px
    base = multiply(scale(sx, sy), [1, 0, 0, 1, -vb[0], -vb[1]])
    widthMm = vb[2] * sx
    heightMm = vb[3] * sy
  } else {
    base = scale(UNIT.px)
    widthMm = (wAttr ?? 0) || 0
    heightMm = (hAttr ?? 0) || 0
  }

  const shapes: ImportedShape[] = []
  const walk = (nodes: XNode[], m: Matrix, inherited: Attrs) => {
    for (const n of nodes) {
      if (['defs', 'clippath', 'mask', 'symbol', 'metadata', 'title', 'desc', 'style', 'text'].includes(n.tag)) continue
      const st = style(n.attrs)
      if (st.display === 'none') continue
      const mm = multiply(m, parseTransform(n.attrs.transform))
      const own: Attrs = { ...inherited }
      for (const k of ['stroke', 'fill']) if (st[k] !== undefined) own[k] = st[k]
      if (n.tag === 'g' || n.tag === 'svg' || n.tag === 'a') {
        walk(n.children, mm, own)
        continue
      }
      const d = shapeToPath(n)
      if (!d) continue
      const segs = transformSegs(parsePath(d), mm)
      if (!segs.length) continue
      const stroke = own.stroke && own.stroke !== 'none' ? own.stroke : null
      const fill = own.fill === undefined ? '#000000' : own.fill !== 'none' ? own.fill : null
      const color = normColor(stroke ?? fill ?? '#000000')
      shapes.push({ d: serializePath(segs), color, filled: !stroke && !!fill })
    }
  }
  walk(root.children, base, {})

  if (!widthMm || !heightMm) {
    // No size given anywhere: measure the geometry.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const s of shapes)
      for (const g of parsePath(s.d)) {
        if (g.t === 'Z') continue
        for (let i = 0; i < g.p.length; i += 2) {
          minX = Math.min(minX, g.p[i])
          maxX = Math.max(maxX, g.p[i])
          minY = Math.min(minY, g.p[i + 1])
          maxY = Math.max(maxY, g.p[i + 1])
        }
      }
    widthMm = Number.isFinite(maxX) ? maxX : 0
    heightMm = Number.isFinite(maxY) ? maxY : 0
  }
  void IDENTITY
  return { shapes, widthMm, heightMm }
}
