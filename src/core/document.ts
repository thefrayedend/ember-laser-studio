import { flattenPath } from './geometry/path'
import { objectMatrix, multiply, IDENTITY } from './geometry/matrix'
import { apply } from './geometry/matrix'
import type { ImageAdjust, LayerJob, LayerSettings, Matrix, PlacedImage, Polyline } from './types'
import { defaultLayer } from './types'

interface BaseObj {
  id: string
  name: string
  layerId: string
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

export interface PathObj extends BaseObj {
  type: 'path'
  /** Path data in local mm, origin where the object's position is. */
  d: string
  shape: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'path'
}
export interface ImageObj extends BaseObj {
  type: 'image'
  assetId: string
  widthMm: number
  heightMm: number
  adjust: ImageAdjust
}
export interface TextObj extends BaseObj {
  type: 'text'
  text: string
  fontFamily: string
  /** Em size in mm */
  fontSizeMm: number
  bold: boolean
  italic: boolean
}
export type DesignObject = PathObj | ImageObj | TextObj

export interface DesignDoc {
  version: 1
  machineId: string
  layers: LayerSettings[]
  objects: DesignObject[]
}

export interface Bitmap {
  width: number
  height: number
  gray: Uint8Array
}

export interface AssetProvider {
  image(assetId: string): Bitmap | undefined
  /** Rasterise text. widthMm/heightMm are the local size of the bitmap in mm. */
  text(obj: TextObj): (Bitmap & { widthMm: number; heightMm: number }) | undefined
  /** Vector outline for text, when fonts are available. Preferred over the raster. */
  textPath?(obj: TextObj): { d: string; widthMm: number; heightMm: number } | undefined
}

export const LAYER_COLORS = ['#ff5a36', '#2f9bff', '#2ecc71', '#f5b301', '#b46bff', '#00c2c7', '#ff7ab6', '#9aa4b2']

export function newDoc(machineId: string): DesignDoc {
  return {
    version: 1,
    machineId,
    layers: [
      // Falcon2 12W starting points (Creality: basswood engrave 40% @ 4000 mm/min). Test on scrap first.
      { ...defaultLayer('L1', 'Engrave', LAYER_COLORS[0]), mode: 'fill', speed: 66.6667, power: 40, lineInterval: 0.1 },
      { ...defaultLayer('L2', 'Cut', LAYER_COLORS[1]), mode: 'line', speed: 3.3333, power: 100, passes: 3, airAssist: true },
      { ...defaultLayer('L3', 'Score', LAYER_COLORS[2]), mode: 'line', speed: 50, power: 20, passes: 1 },
    ],
    objects: [],
  }
}

export function objMatrix(o: DesignObject): Matrix {
  return objectMatrix(o.x, o.y, o.rotation, o.scaleX, o.scaleY)
}

/** Turn the document into per-layer geometry ready for G-code generation. */
export function compileDoc(doc: DesignDoc, assets: AssetProvider, tolerance = 0.05): LayerJob[] {
  const jobs = new Map<string, LayerJob>()
  for (const l of doc.layers) jobs.set(l.id, { settings: l, vectors: [], images: [] })
  doc.objects.forEach((o, index) => {
    const job = jobs.get(o.layerId)
    if (!job || !job.settings.visible) return
    const m = objMatrix(o)
    if (o.type === 'path') {
      const polys: Polyline[] = flattenPath(o.d, tolerance, m)
      for (const p of polys) {
        p.group = index
        job.vectors.push(p)
      }
    } else if (o.type === 'image') {
      const bmp = assets.image(o.assetId)
      if (!bmp) return
      const img: PlacedImage = { ...bmp, widthMm: o.widthMm, heightMm: o.heightMm, matrix: m, adjust: o.adjust }
      job.images.push(img)
    } else {
      const shape = assets.textPath?.(o)
      if (shape) {
        for (const p of flattenPath(shape.d, tolerance, m)) {
          p.group = index
          job.vectors.push(p)
        }
        return
      }
      const bmp = assets.text(o)
      if (!bmp) return
      job.images.push({ ...bmp, matrix: m })
    }
  })
  return doc.layers.map((l) => jobs.get(l.id)!)
}

/** Axis-aligned bounds of an object in design space, using a cheap flatten for paths. */
export function objectBounds(o: DesignObject, assets?: AssetProvider) {
  const m = objMatrix(o)
  let pts: { x: number; y: number }[] = []
  if (o.type === 'path') {
    for (const p of flattenPath(o.d, 0.2, m)) pts = pts.concat(p.points)
  } else {
    let w = 0
    let h = 0
    if (o.type === 'image') {
      w = o.widthMm
      h = o.heightMm
    } else {
      const t = assets?.textPath?.(o) ?? assets?.text(o)
      w = t?.widthMm ?? o.fontSizeMm * o.text.length * 0.6
      h = t?.heightMm ?? o.fontSizeMm
    }
    pts = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ].map((p) => apply(m, p))
  }
  if (!pts.length) return null
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  }
}

export function serializeDoc(doc: DesignDoc, images: Record<string, string>): string {
  return JSON.stringify({ app: 'ember-laser-studio', doc, images }, null, 1)
}

export function parseDocFile(text: string): { doc: DesignDoc; images: Record<string, string> } {
  const j = JSON.parse(text)
  if (j.app !== 'ember-laser-studio' || !j.doc) throw new Error('Not an Ember project file.')
  return { doc: j.doc as DesignDoc, images: (j.images ?? {}) as Record<string, string> }
}

void multiply
void IDENTITY
