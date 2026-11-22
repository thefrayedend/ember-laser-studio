import type { TextObj } from '../../core/document'
import { FONT_FAMILIES, parseFont, textToPath, type TextShape } from '../../core/text/vectorText'

type Font = ReturnType<typeof parseFont>
const urls = import.meta.glob('../../../node_modules/@fontsource/*/files/*-latin-{400,700}-{normal,italic}.woff', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const faces = new Map<string, Font>() // key: slug|weight|style
const slug = (f: string) => f.toLowerCase().replace(/\s+/g, '-')
let ready: Promise<void> | null = null

export const FONT_LIST: readonly string[] = FONT_FAMILIES

export function loadFonts(): Promise<void> {
  if (ready) return ready
  ready = Promise.all(
    Object.entries(urls).map(async ([path, url]) => {
      const m = /files\/(.+)-latin-(400|700)-(normal|italic)\.woff$/.exec(path)
      if (!m) return
      try {
        const buf = await (await fetch(url)).arrayBuffer()
        faces.set(`${m[1]}|${m[2]}|${m[3]}`, parseFont(buf))
      } catch (err) {
        console.warn('font failed', path, err)
      }
    }),
  ).then(() => undefined)
  return ready
}

export function pickFont(family: string, bold: boolean, italic: boolean): Font | undefined {
  const s = slug(family)
  const tries = [
    `${s}|${bold ? 700 : 400}|${italic ? 'italic' : 'normal'}`,
    `${s}|${bold ? 700 : 400}|normal`,
    `${s}|400|${italic ? 'italic' : 'normal'}`,
    `${s}|400|normal`,
    'roboto|400|normal',
  ]
  for (const k of tries) {
    const f = faces.get(k)
    if (f) return f
  }
  return undefined
}

const cache = new Map<string, TextShape | null>()
export function textShape(o: Pick<TextObj, 'text' | 'fontFamily' | 'fontSizeMm' | 'bold' | 'italic'>): TextShape | undefined {
  if (!o.text.trim()) return undefined
  const key = `${o.text}|${o.fontFamily}|${o.fontSizeMm}|${o.bold}|${o.italic}|${faces.size}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit ?? undefined
  const font = pickFont(o.fontFamily, o.bold, o.italic)
  const out = font ? textToPath(font, o.text, o.fontSizeMm) : null
  if (cache.size > 200) cache.clear()
  cache.set(key, out)
  return out ?? undefined
}
