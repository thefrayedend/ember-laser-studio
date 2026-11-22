import opentype from 'opentype.js'

export interface FontFace {
  family: string
  bold: boolean
  italic: boolean
  font: opentype.Font
}

export interface TextShape {
  /** Path data in local mm, y down, origin at top-left of the text box */
  d: string
  widthMm: number
  heightMm: number
}

export function parseFont(buf: ArrayBuffer): opentype.Font {
  return opentype.parse(buf)
}

const r3 = (n: number) => String(Math.round(n * 1000) / 1000)

/** Path data with every contour explicitly closed (opentype.js leaves contours open). */
function closedPathData(path: opentype.Path): string {
  let d = ''
  let open = false
  for (const c of path.commands as { type: string; x: number; y: number; x1: number; y1: number; x2: number; y2: number }[]) {
    if (c.type === 'M') {
      if (open) d += 'Z'
      d += `M${r3(c.x)} ${r3(c.y)}`
      open = true
    } else if (c.type === 'L') d += `L${r3(c.x)} ${r3(c.y)}`
    else if (c.type === 'Q') d += `Q${r3(c.x1)} ${r3(c.y1)} ${r3(c.x)} ${r3(c.y)}`
    else if (c.type === 'C') d += `C${r3(c.x1)} ${r3(c.y1)} ${r3(c.x2)} ${r3(c.y2)} ${r3(c.x)} ${r3(c.y)}`
    else if (c.type === 'Z') {
      d += 'Z'
      open = false
    }
  }
  return open ? d + 'Z' : d
}

/** Lay out one line glyph by glyph (skips GSUB shaping, which some fonts break in opentype.js). */
function layoutLine(font: opentype.Font, line: string, size: number, baseline: number, spacing: number) {
  const scale = size / font.unitsPerEm
  let x = 0
  let d = ''
  let prev: opentype.Glyph | undefined
  for (const ch of line) {
    const g = font.charToGlyph(ch)
    if (prev) x += font.getKerningValue(prev, g) * scale
    d += closedPathData(g.getPath(x, baseline, size))
    x += (g.advanceWidth ?? 0) * scale + spacing
    prev = g
  }
  return { d, width: x - (line ? spacing : 0) }
}

/** Convert (multi-line) text to a filled outline path. One line = fontSizeMm * lineHeight tall. */
export function textToPath(font: opentype.Font, text: string, fontSizeMm: number, lineHeight = 1.2, letterSpacingMm = 0): TextShape {
  const lines = text.split('\n')
  const asc = (font.ascender / font.unitsPerEm) * fontSizeMm
  let d = ''
  let width = 0
  lines.forEach((line, i) => {
    if (!line) return
    const r = layoutLine(font, line, fontSizeMm, i * fontSizeMm * lineHeight + asc, letterSpacingMm)
    d += r.d
    width = Math.max(width, r.width)
  })
  return { d, widthMm: Math.max(width, 0.1), heightMm: Math.max(lines.length * fontSizeMm * lineHeight, 0.1) }
}

export const FONT_FAMILIES = ['Roboto', 'Roboto Slab', 'Roboto Mono', 'Oswald', 'Bebas Neue', 'Playfair Display', 'Pacifico', 'Dancing Script'] as const
