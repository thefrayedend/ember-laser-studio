import type { AssetProvider, Bitmap, TextObj } from '../../core/document'
import { textShape } from './fonts'

export interface ImageAsset {
  dataUrl: string
  el: HTMLImageElement
  bmp: Bitmap
  /** natural size in px */
  width: number
  height: number
}

const MAX_PX = 3000
const assets = new Map<string, ImageAsset>()
let seq = 0

export const getAsset = (id: string) => assets.get(id)
export const allAssetUrls = () => Object.fromEntries([...assets].map(([k, v]) => [k, v.dataUrl]))
export const clearAssets = () => assets.clear()

function toGray(canvas: HTMLCanvasElement): Bitmap {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const gray = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0; i < gray.length; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return { width: canvas.width, height: canvas.height, gray }
}

export function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not read that image.'))
    el.src = dataUrl
  })
}

export async function registerImage(dataUrl: string, id?: string): Promise<{ id: string; asset: ImageAsset }> {
  const el = await loadImageEl(dataUrl)
  const k = Math.min(1, MAX_PX / Math.max(el.naturalWidth, el.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(el.naturalWidth * k))
  c.height = Math.max(1, Math.round(el.naturalHeight * k))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff' // transparent pixels become white = no burn
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(el, 0, 0, c.width, c.height)
  const assetId = id ?? `img${++seq}_${Date.now().toString(36)}`
  const asset: ImageAsset = { dataUrl, el, bmp: toGray(c), width: el.naturalWidth, height: el.naturalHeight }
  assets.set(assetId, asset)
  return { id: assetId, asset }
}

export const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

const PX_PER_MM = 10
const textCache = new Map<string, ReturnType<AssetProvider['text']>>()

export function textMetrics(o: Pick<TextObj, 'text' | 'fontFamily' | 'fontSizeMm' | 'bold' | 'italic'>) {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  const px = o.fontSizeMm * PX_PER_MM
  ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${o.fontFamily}`
  const lines = o.text.split('\n')
  const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width))
  return { px, lines, widthPx: Math.ceil(w), heightPx: Math.ceil(px * 1.2 * lines.length) }
}

export function rasterizeText(o: TextObj) {
  const key = `${o.text}|${o.fontFamily}|${o.fontSizeMm}|${o.bold}|${o.italic}`
  const hit = textCache.get(key)
  if (hit) return hit
  if (!o.text.trim()) return undefined
  const m = textMetrics(o)
  const c = document.createElement('canvas')
  c.width = m.widthPx
  c.height = m.heightPx
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'top'
  ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${m.px}px ${o.fontFamily}`
  m.lines.forEach((l, i) => ctx.fillText(l, 0, i * m.px * 1.2 + m.px * 0.1))
  const out = { ...toGray(c), widthMm: c.width / PX_PER_MM, heightMm: c.height / PX_PER_MM }
  if (textCache.size > 50) textCache.clear()
  textCache.set(key, out)
  return out
}

export const assetProvider: AssetProvider = {
  image: (id) => assets.get(id)?.bmp,
  text: (o) => rasterizeText(o),
  textPath: (o) => textShape(o),
}
