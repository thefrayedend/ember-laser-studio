import { create } from 'zustand'
import { isRemote } from './lib/transport'
import { buildTest, type BuiltTest, type TestId } from '../core/test/suites'
import {
  compileDoc,
  LAYER_COLORS,
  newDoc,
  objectBounds,
  parseDocFile,
  serializeDoc,
  type DesignDoc,
  type DesignObject,
  type ImageObj,
  type PathObj,
  type TextObj,
} from '../core/document'
import { importSvg } from '../core/svg/import'
import { BUILTIN_PRESETS, type MaterialPreset } from '../core/materials'
import { generateFrame, generateFrameRaw } from '../core/gcode/generate'
import { rectPath } from '../core/geometry/path'
import { defaultLayer, FALCON2_12W, FALCON2_22W, type GenResult, type LayerSettings, type MachineProfile, type OriginMode } from '../core/types'
import type { MachineStatus } from '../core/grbl/protocol'
import type { JobProgress } from '../core/grbl/client'
import type { PackedMoves, WorkerIn, WorkerOut } from './lib/gen.worker'
import { traceBitmap, polylinesToPath, type TraceOptions } from '../core/raster/trace'
import { textShape, loadFonts } from './lib/fonts'
import { allAssetUrls, assetProvider, clearAssets, getAsset, readAsDataUrl, registerImage, textMetrics } from './lib/assets'

export type Tab = 'design' | 'preview' | 'device'
export type Tool = 'select' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'text'

export interface ConsoleLine {
  id: number
  dir: 'tx' | 'rx' | 'info' | 'err'
  text: string
}

export interface Conn {
  connected: boolean
  label?: string
  kind?: string
  deviceJobs?: boolean
}

export interface GenState {
  /** Extra explanation shown in Preview (used by the material test). */
  note?: string
  result: GenResult | null
  packed: PackedMoves
  lines: string[]
  name: string
  fromDesign: boolean
}

/** What the laser box says about software updates (only present when the app runs on the box). */
export interface UpdateInfo {
  enabled: boolean
  current: string
  latest: string | null
  available: boolean
  notes: string
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'error'
  message: string
  auto: boolean
}

export interface CameraCfg {
  on: boolean
  deviceId: string
  /** Network camera picture (MJPEG stream address). Empty means a camera plugged into this computer. */
  url: string
  /** four bed corners (TL, TR, BR, BL) in camera pixels */
  corners: { x: number; y: number }[] | null
  opacity: number
}

function loadCamera(): CameraCfg {
  try {
    const t = localStorage.getItem('ember.camera')
    if (t) return { on: false, deviceId: '', url: '', corners: null, opacity: 0.7, ...JSON.parse(t) }
  } catch {
    /* ignore */
  }
  return { on: false, deviceId: '', url: '', corners: null, opacity: 0.7 }
}

interface State {
  doc: DesignDoc
  history: DesignDoc[]
  future: DesignDoc[]
  machine: MachineProfile
  origin: OriginMode
  selection: string[]
  tab: Tab
  tool: Tool
  assetVersion: number
  fileName: string

  gen: GenState | null
  genBusy: boolean
  genError: string | null
  /** G-code that is sent as written. jobOrigin: its 0,0 is the head position (material tests), so Ember sets zero there first. */
  raw: { name: string; lines: string[]; jobOrigin?: boolean } | null
  /** The machine finished a homing cycle since it connected (so bed coordinates are real). */
  homed: boolean

  userPresets: MaterialPreset[]

  conn: Conn
  status: MachineStatus | null
  settings: Record<number, string>
  job: (JobProgress & { where: 'pc' | 'device' }) | null
  console: ConsoleLine[]
  alarm: string | null
  update: UpdateInfo | null
  camera: CameraCfg
  speedUnit: 'mm/s' | 'mm/min'
  setSpeedUnit: (u: 'mm/s' | 'mm/min') => void
  setCamera: (c: Partial<CameraCfg>) => void
  profiles: MachineProfile[]
  selectMachine: (id: string) => void
  deleteMachine: (id: string) => void
  lastJob: { lines: string[]; name: string } | null
  resumable: { lines: string[]; name: string; acked: number; pos: { x: number; y: number } | null } | null
  toast: { id: number; kind: 'info' | 'error' | 'ok'; text: string } | null
  sendOpen: boolean
}

interface Actions {
  setTab: (t: Tab) => void
  setTool: (t: Tool) => void
  select: (ids: string[]) => void
  commit: () => void
  undo: () => void
  redo: () => void
  addObject: (o: DesignObject) => void
  updateObject: (id: string, patch: Partial<DesignObject>, noHistory?: boolean) => void
  removeSelected: () => void
  duplicateSelected: () => void
  setLayer: (id: string, patch: Partial<LayerSettings>) => void
  addLayer: () => void
  removeLayer: (id: string) => void
  moveLayer: (id: string, dir: -1 | 1) => void
  applyPreset: (layerId: string, p: MaterialPreset) => void
  saveLayerAsPreset: (layerId: string, name: string) => void
  setMachine: (m: MachineProfile) => void
  setOrigin: (o: OriginMode) => void
  importFiles: (files: File[]) => Promise<void>
  newProject: () => void
  saveProject: () => Promise<void>
  openProject: (file: File) => Promise<void>
  addShape: (shape: PathObj['shape'], d: string, w: number, h: number, at?: { x: number; y: number }) => string
  addText: (at?: { x: number; y: number }) => string
  traceImage: (id: string, opts: TraceOptions, keepImage: boolean) => void
  generate: () => Promise<GenState | null>
  makeFrameLines: () => string[] | null
  makeTest: (id: TestId, o: { speed: number; power: number; speeds: number[]; powers: number[]; thickness: number }) => Promise<void>
  lastTest: BuiltTest | null
  testOpen: boolean
  me: { name: string; role: 'admin' | 'user' | 'viewer' } | null
  adminOpen: boolean
  setAdminOpen: (v: boolean) => void
  powerCap: number
  helpOpen: string | null
  setHelpOpen: (t: string | null) => void
  setTestOpen: (v: boolean) => void
  addUserPreset: (p: MaterialPreset) => void
  openSend: (v: boolean) => void
  notify: (kind: 'info' | 'error' | 'ok', text: string) => void
  log: (dir: ConsoleLine['dir'], text: string) => void
  handleEvent: (e: any) => void
  api: <T = unknown>(name: string, args?: unknown) => Promise<T | undefined>
}

declare global {
  interface Window {
    ember: { invoke: (name: string, args?: unknown) => Promise<unknown>; onEvent: (cb: (e: unknown) => void) => () => void }
  }
}

let idSeq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`
let consoleSeq = 0
let toastSeq = 0

const worker = new Worker(new URL('./lib/gen.worker.ts', import.meta.url), { type: 'module' })
let reqSeq = 0
const waiting = new Map<number, (o: WorkerOut) => void>()
worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  waiting.get(ev.data.id)?.(ev.data)
  waiting.delete(ev.data.id)
}
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
const callWorker = (msg: DistributiveOmit<WorkerIn, 'id'>) =>
  new Promise<WorkerOut>((resolve) => {
    const id = ++reqSeq
    waiting.set(id, resolve)
    worker.postMessage({ ...msg, id })
  })

export const MACHINE_TEMPLATES: MachineProfile[] = [
  FALCON2_12W,
  FALCON2_22W,
  { ...FALCON2_22W, id: 'generic-300', name: 'Generic diode laser 300×300', bedWidth: 300, bedHeight: 300, maxSpeed: 200 },
]

function loadProfiles(): MachineProfile[] {
  try {
    const t = localStorage.getItem('ember.machines')
    if (t) {
      const v = JSON.parse(t) as MachineProfile[]
      if (Array.isArray(v) && v.length) {
        const list = v.map((p) => ({ ...FALCON2_12W, ...p }))
        return list.some((p) => p.id === FALCON2_12W.id) ? list : [FALCON2_12W, ...list]
      }
    }
  } catch {
    /* ignore */
  }
  const cur = loadMachine()
  return cur.id === FALCON2_12W.id ? [cur] : [FALCON2_12W, cur]
}
function saveProfiles(p: MachineProfile[]) {
  try {
    localStorage.setItem('ember.machines', JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

function loadMachine(): MachineProfile {
  try {
    const s = localStorage.getItem('ember.machine')
    // v0.1/0.2 defaulted to the 22W profile. Move an untouched default over to the 12W once.
    if (s && !localStorage.getItem('ember.migrated12w')) {
      localStorage.setItem('ember.migrated12w', '1')
      if (JSON.parse(s).id === FALCON2_22W.id) return FALCON2_12W
    }
    if (s) return { ...FALCON2_12W, ...JSON.parse(s) }
  } catch {
    /* ignore */
  }
  return FALCON2_12W
}

export const useStore = create<State & Actions>((set, get) => {
  const mutateDoc = (fn: (d: DesignDoc) => DesignDoc, history = true) => {
    const { doc, history: h } = get()
    const next = fn(doc)
    set({
      doc: next,
      history: history ? [...h.slice(-99), doc] : h,
      future: history ? [] : get().future,
      gen: null,
    })
  }

  return {
    doc: newDoc(FALCON2_12W.id),
    history: [],
    future: [],
    machine: loadMachine(),
    origin: { mode: 'job', anchor: 'tl' },
    selection: [],
    tab: 'design',
    tool: 'select',
    assetVersion: 0,
    fileName: 'Untitled',
    gen: null,
    genBusy: false,
    genError: null,
    raw: null,
    homed: false,
    userPresets: [],
    lastTest: null,
    testOpen: false,
    me: null,
    adminOpen: false,
    setAdminOpen: (adminOpen) => set({ adminOpen }),
    powerCap: 100,
    helpOpen: null,
    setHelpOpen: (helpOpen) => set({ helpOpen }),
    setTestOpen: (testOpen) => set({ testOpen }),
    addUserPreset: (p) => {
      const userPresets = [...get().userPresets, p]
      set({ userPresets })
      void get().api('presets.save', userPresets)
    },
    conn: { connected: false },
    status: null,
    settings: {},
    job: null,
    console: [],
    alarm: null,
    update: null,
    toast: null,
    lastJob: null,
    resumable: null,
    speedUnit: (() => {
      try {
        return localStorage.getItem('ember.speedUnit') === 'mm/s' ? 'mm/s' : 'mm/min'
      } catch {
        return 'mm/min'
      }
    })() as 'mm/s' | 'mm/min',
    setSpeedUnit: (u) => {
      try {
        localStorage.setItem('ember.speedUnit', u)
      } catch {
        /* ignore */
      }
      set({ speedUnit: u })
    },
    camera: loadCamera(),
    setCamera: (c) => {
      const camera = { ...get().camera, ...c }
      try {
        localStorage.setItem('ember.camera', JSON.stringify(camera))
      } catch {
        /* ignore */
      }
      set({ camera })
    },
    profiles: loadProfiles(),
    selectMachine: (id) => {
      const m = get().profiles.find((p) => p.id === id)
      if (m) get().setMachine(m)
    },
    deleteMachine: (id) => {
      const profiles = get().profiles.filter((p) => p.id !== id)
      if (!profiles.length) return
      saveProfiles(profiles)
      set({ profiles })
      if (get().machine.id === id) get().setMachine(profiles[0])
    },
    sendOpen: false,

    setTab: (tab) => set({ tab }),
    setTool: (tool) => set({ tool }),
    select: (selection) => set({ selection }),
    commit: () => {},
    undo: () => {
      const { history, doc, future } = get()
      if (!history.length) return
      set({ doc: history[history.length - 1], history: history.slice(0, -1), future: [doc, ...future], gen: null, selection: [] })
    },
    redo: () => {
      const { future, doc, history } = get()
      if (!future.length) return
      set({ doc: future[0], future: future.slice(1), history: [...history, doc], gen: null, selection: [] })
    },

    addObject: (o) => {
      mutateDoc((d) => ({ ...d, objects: [...d.objects, o] }))
      set({ selection: [o.id] })
    },
    updateObject: (id, patch, noHistory) =>
      mutateDoc((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as DesignObject) : o)) }), !noHistory),
    removeSelected: () => {
      const sel = new Set(get().selection)
      if (!sel.size) return
      mutateDoc((d) => ({ ...d, objects: d.objects.filter((o) => !sel.has(o.id)) }))
      set({ selection: [] })
    },
    duplicateSelected: () => {
      const sel = new Set(get().selection)
      const copies = get()
        .doc.objects.filter((o) => sel.has(o.id))
        .map((o) => ({ ...o, id: uid('o'), x: o.x + 5, y: o.y + 5 }))
      if (!copies.length) return
      mutateDoc((d) => ({ ...d, objects: [...d.objects, ...copies] }))
      set({ selection: copies.map((c) => c.id) })
    },

    setLayer: (id, patch) => mutateDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
    addLayer: () =>
      mutateDoc((d) => {
        const n = d.layers.length
        return { ...d, layers: [...d.layers, { ...defaultLayer(uid('L'), `Layer ${n + 1}`, LAYER_COLORS[n % LAYER_COLORS.length]) }] }
      }),
    removeLayer: (id) => {
      const { doc } = get()
      if (doc.layers.length <= 1) return get().notify('error', 'A design needs at least one layer.')
      const fallback = doc.layers.find((l) => l.id !== id)!.id
      mutateDoc((d) => ({
        ...d,
        layers: d.layers.filter((l) => l.id !== id),
        objects: d.objects.map((o) => (o.layerId === id ? { ...o, layerId: fallback } : o)),
      }))
    },
    moveLayer: (id, dir) =>
      mutateDoc((d) => {
        const i = d.layers.findIndex((l) => l.id === id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= d.layers.length) return d
        const layers = d.layers.slice()
        ;[layers[i], layers[j]] = [layers[j], layers[i]]
        return { ...d, layers }
      }),
    applyPreset: (layerId, p) => get().setLayer(layerId, { ...p.settings } as Partial<LayerSettings>),
    saveLayerAsPreset: (layerId, name) => {
      const l = get().doc.layers.find((x) => x.id === layerId)
      if (!l) return
      const p: MaterialPreset = {
        id: uid('user'),
        name,
        material: 'My presets',
        operation: l.mode === 'line' ? 'cut' : 'engrave',
        settings: { mode: l.mode, speed: l.speed, power: l.power, minPower: l.minPower, passes: l.passes, lineInterval: l.lineInterval, dither: l.dither, airAssist: l.airAssist },
      }
      const userPresets = [...get().userPresets, p]
      set({ userPresets })
      void get().api('presets.save', userPresets)
    },

    setMachine: (m) => {
      try {
        localStorage.setItem('ember.machine', JSON.stringify(m))
      } catch {
        /* ignore */
      }
      const profiles = get().profiles.some((p) => p.id === m.id) ? get().profiles.map((p) => (p.id === m.id ? m : p)) : [...get().profiles, m]
      saveProfiles(profiles)
      set({ machine: m, profiles, gen: null })
    },
    setOrigin: (origin) => set({ origin, gen: null }),

    addShape: (shape, d, w, h, at) => {
      const { machine, doc } = get()
      const o: PathObj = {
        id: uid('o'),
        name: shape[0].toUpperCase() + shape.slice(1),
        type: 'path',
        shape,
        d,
        layerId: doc.layers[1]?.id ?? doc.layers[0].id,
        x: at ? at.x - w / 2 : machine.bedWidth / 2 - w / 2,
        y: at ? at.y - h / 2 : machine.bedHeight / 2 - h / 2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      }
      get().addObject(o)
      return o.id
    },
    traceImage: (id, opts, keepImage) => {
      const { doc } = get()
      const img = doc.objects.find((o) => o.id === id)
      const a = img && img.type === 'image' ? getAsset(img.assetId) : undefined
      if (!img || img.type !== 'image' || !a) return
      // trace at a sane resolution: big photos are downsampled first
      const k = Math.min(1, 1200 / Math.max(a.bmp.width, a.bmp.height))
      const w = Math.max(1, Math.round(a.bmp.width * k))
      const h = Math.max(1, Math.round(a.bmp.height * k))
      let gray = a.bmp.gray
      if (k < 1) {
        gray = new Uint8Array(w * h)
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = a.bmp.gray[Math.min(a.bmp.height - 1, Math.floor(y / k)) * a.bmp.width + Math.min(a.bmp.width - 1, Math.floor(x / k))]
      }
      const lines = traceBitmap(gray, w, h, { ...opts, tolerance: opts.tolerance * (k < 1 ? 1.5 : 1) })
      if (!lines.length) return get().notify('error', 'Nothing to trace at that threshold. Try moving the slider.')
      const d = polylinesToPath(lines, img.widthMm / w, img.heightMm / h)
      const layer = doc.layers.find((l) => l.mode === 'line') ?? doc.layers[0]
      const o: PathObj = { id: uid('o'), name: 'Traced ' + img.name, type: 'path', shape: 'path', d, layerId: layer.id, x: img.x, y: img.y, rotation: img.rotation, scaleX: img.scaleX, scaleY: img.scaleY }
      mutateDoc((dd) => ({ ...dd, objects: [...dd.objects.filter((x) => keepImage || x.id !== id), o] }))
      set({ selection: [o.id] })
      get().notify('ok', `Traced into ${lines.length} paths on "${layer.name}".`)
    },
    addText: (at) => {
      const { machine, doc } = get()
      const base = { text: 'Hello', fontFamily: 'Roboto', fontSizeMm: 12, bold: false, italic: false }
      const sh = textShape(base)
      const m = { widthPx: (sh?.widthMm ?? textMetrics(base).widthPx / 10) * 10, heightPx: (sh?.heightMm ?? textMetrics(base).heightPx / 10) * 10 }
      const o: TextObj = {
        id: uid('o'),
        name: 'Text',
        type: 'text',
        ...base,
        layerId: doc.layers[0].id,
        x: (at?.x ?? machine.bedWidth / 2) - m.widthPx / 20,
        y: (at?.y ?? machine.bedHeight / 2) - m.heightPx / 20,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      }
      get().addObject(o)
      return o.id
    },

    importFiles: async (files) => {
      const { machine, notify } = get()
      for (const file of files) {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
        try {
          if (ext === 'svg') {
            const svg = importSvg(await file.text())
            if (!svg.shapes.length) throw new Error('No shapes found in that SVG.')
            // Keep it simple: filled shapes go to the first Fill layer (Engrave), outlines to the first Line layer (Cut).
            // Colours are not turned into layers. Re-assign anything with the Cut / Score / Engrave buttons.
            const doc = get().doc
            const fillLayer = doc.layers.find((l) => l.mode === 'fill') ?? doc.layers[0]
            const lineLayer = doc.layers.find((l) => l.mode === 'line') ?? doc.layers[0]
            const groups = { fill: '', line: '' }
            for (const s of svg.shapes) groups[s.filled ? 'fill' : 'line'] += s.d
            // Don't pile new imports on top of what is already there: step each one down and to the right.
            const nudge = Math.min(80, doc.objects.length * 12)
            const cx = Math.max(0, Math.min(machine.bedWidth - svg.widthMm, machine.bedWidth / 2 - svg.widthMm / 2 + nudge))
            const cy = Math.max(0, Math.min(machine.bedHeight - svg.heightMm, machine.bedHeight / 2 - svg.heightMm / 2 + nudge))
            const objs: DesignObject[] = []
            const newLayers: LayerSettings[] = []
            for (const kind of ['line', 'fill'] as const) {
              if (!groups[kind]) continue
              objs.push({ id: uid('o'), name: `${file.name} ${kind === 'fill' ? 'filled shapes' : 'outlines'}`, type: 'path', shape: 'path', d: groups[kind], layerId: (kind === 'fill' ? fillLayer : lineLayer).id, x: cx, y: cy, rotation: 0, scaleX: 1, scaleY: 1 })
            }
            mutateDoc((d) => ({ ...d, layers: [...d.layers, ...newLayers], objects: [...d.objects, ...objs] }))
            set({ selection: objs.map((o) => o.id), raw: null, tab: 'design' })
          } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) {
            const url = await readAsDataUrl(file)
            const { id, asset } = await registerImage(url)
            let w = (asset.width * 25.4) / 96
            let h = (asset.height * 25.4) / 96
            const k = Math.min(1, (machine.bedWidth * 0.8) / w, (machine.bedHeight * 0.8) / h)
            w *= k
            h *= k
            const doc = get().doc
            const o: ImageObj = {
              id: uid('o'),
              name: file.name,
              type: 'image',
              assetId: id,
              widthMm: w,
              heightMm: h,
              adjust: { brightness: 0, contrast: 0, invert: false },
              layerId: doc.layers[0].id,
              x: Math.max(0, Math.min(machine.bedWidth - w, machine.bedWidth / 2 - w / 2 + Math.min(80, doc.objects.length * 12))),
              y: Math.max(0, Math.min(machine.bedHeight - h, machine.bedHeight / 2 - h / 2 + Math.min(80, doc.objects.length * 12))),
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
            }
            set({ assetVersion: get().assetVersion + 1, raw: null, tab: 'design' })
            get().addObject(o)
            // Photos look best as grayscale; line art as threshold. Start with a sensible default for photos.
            get().setLayer(doc.layers[0].id, { mode: 'fill' })
          } else if (['nc', 'gcode', 'gc', 'ngc', 'tap', 'txt', 'gco'].includes(ext)) {
            const text = await file.text()
            const lines = text.split(/\r?\n/)
            set({ raw: { name: file.name, lines }, gen: null, tab: 'preview' })
            notify('info', `Loaded ${file.name} as raw G-code (${lines.length} lines).`)
          } else if (ext === 'ember') {
            await get().openProject(file)
          } else {
            throw new Error(`Unsupported file type: .${ext}`)
          }
        } catch (e) {
          notify('error', `${file.name}: ${(e as Error).message}`)
        }
      }
    },

    newProject: () => {
      clearAssets()
      set({ doc: newDoc(get().machine.id), history: [], future: [], selection: [], gen: null, raw: null, fileName: 'Untitled', assetVersion: get().assetVersion + 1 })
    },
    saveProject: async () => {
      const { doc, fileName } = get()
      const path = await get().api<string | null>('file.save', {
        defaultName: `${fileName}.ember`,
        data: serializeDoc(doc, allAssetUrls()),
        filters: [{ name: 'Ember project', extensions: ['ember'] }],
      })
      if (path) get().notify('ok', 'Project saved.')
    },
    openProject: async (file) => {
      const { doc, images } = parseDocFile(await file.text())
      clearAssets()
      for (const [id, url] of Object.entries(images)) await registerImage(url, id)
      set({ doc, history: [], future: [], selection: [], gen: null, raw: null, fileName: file.name.replace(/\.ember$/, ''), assetVersion: get().assetVersion + 1, tab: 'design' })
    },

    generate: async () => {
      const { doc, machine, origin, raw } = get()
      set({ genBusy: true, genError: null })
      try {
        if (raw) {
          const out = await callWorker({ type: 'parse', lines: raw.lines })
          if (!out.ok) throw new Error(out.error)
          const g: GenState = { result: null, packed: out.packed, lines: raw.lines, name: raw.name, fromDesign: false }
          set({ gen: g, genBusy: false })
          return g
        }
        await loadFonts()
        const jobs = compileDoc(doc, assetProvider)
        const out = await callWorker({ type: 'generate', jobs, opts: { machine, origin, returnToOrigin: true, constantPower: false } })
        if (!out.ok) throw new Error(out.error)
        const g: GenState = { result: out.result!, packed: out.packed, lines: out.result!.lines, name: get().fileName, fromDesign: true }
        set({ gen: g, genBusy: false })
        return g
      } catch (e) {
        set({ genBusy: false, genError: (e as Error).message })
        return null
      }
    },

    makeFrameLines: () => {
      const { doc, machine, origin, raw } = get()
      const bounds = raw
        ? (get().gen?.packed.bounds ?? null)
        : (() => {
            const bs = doc.objects
              .filter((o) => doc.layers.find((l) => l.id === o.layerId)?.output)
              .map((o) => objectBounds(o, assetProvider))
              .filter(Boolean) as { minX: number; minY: number; maxX: number; maxY: number }[]
            if (!bs.length) return null
            return {
              minX: Math.min(...bs.map((b) => b.minX)),
              minY: Math.min(...bs.map((b) => b.minY)),
              maxX: Math.max(...bs.map((b) => b.maxX)),
              maxY: Math.max(...bs.map((b) => b.maxY)),
            }
          })()
      if (!bounds) return null
      // Imported G-code and tests are already in machine/work coordinates: frame them as they are.
      const lines = raw ? generateFrameRaw(bounds) : generateFrame(bounds, machine, origin)
      if (raw ? raw.jobOrigin : origin.mode === 'job') {
        // Set zero where the head is, trace the frame, and come home so Start uses the same origin.
        return ['G10 L20 P1 X0 Y0', ...lines, 'G0 X0 Y0']
      }
      return lines
    },

    makeTest: async (id, o) => {
      // Tests always start where the head is (its bottom-left corner), so they land on the scrap under it.
      const { machine } = get()
      const t = buildTest(id, { ...o, machine, origin: { mode: 'job', anchor: 'bl' } })
      const out = await callWorker({ type: 'parse', lines: t.result.lines })
      if (!out.ok) return get().notify('error', out.error)
      set({ lastTest: t })
      set({ raw: { name: 'material-test.nc', lines: t.result.lines, jobOrigin: true }, gen: { result: t.result, packed: out.packed, lines: t.result.lines, name: 'material-test', fromDesign: false, note: `${t.title}. ${t.note}` }, tab: 'preview' })
    },

    openSend: (sendOpen) => set({ sendOpen }),
    notify: (kind, text) => set({ toast: { id: ++toastSeq, kind, text } }),
    log: (dir, text) => set((s) => ({ console: [...s.console.slice(-499), { id: ++consoleSeq, dir, text }] })),

    api: async (name, args) => {
      try {
        return (await window.ember.invoke(name, args)) as never
      } catch (e) {
        const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        get().notify('error', msg)
        get().log('err', msg)
        return undefined
      }
    },

    handleEvent: (e) => {
      switch (e.type) {
        case 'connection':
          set({ conn: { connected: e.connected, label: e.label, kind: e.kind, deviceJobs: e.deviceJobs }, ...(e.connected ? {} : { status: null, job: null, homed: false }) })
          get().log('info', e.connected ? `Connected: ${e.label}` : `Disconnected${e.error ? `: ${e.error}` : ''}`)
          if (!e.connected && e.error) get().notify('error', `Connection lost: ${e.error}`)
          break
        case 'status': {
          const prev = get().status?.state
          const homed = prev === 'Home' && e.status.state === 'Idle' ? true : e.status.state === 'Alarm' ? false : get().homed
          set({ status: e.status, alarm: e.status.state === 'Alarm' ? get().alarm : null, homed })
          break
        }
        case 'line':
          // While a job streams, thousands of "ok" and G-code lines would bury everything else in the console.
          if (get().job && (e.text === 'ok' || e.dir === 'tx')) break
          get().log(e.dir, e.text)
          break
        case 'alarm':
          set({ alarm: e.message })
          get().log('err', `ALARM:${e.code} ${e.message}`)
          break
        case 'error':
          get().log('err', `error:${e.code} ${e.message}${e.line ? ` (${e.line})` : ''}`)
          get().notify('error', `${e.message}${e.jobLine ? ` Job line ${e.jobLine}.` : ''}`)
          break
        case 'update':
          set({ update: e as UpdateInfo })
          break
        case 'settings':
          set({ settings: e.settings })
          break
        case 'job':
          set({ job: e.progress.state === 'idle' ? null : { ...e.progress, where: e.where } })
          break
        case 'jobEnd': {
          const lj = get().lastJob
          const jp = get().job // last progress report before the job ended
          const wp = get().status?.wpos
          if (e.result === 'done') set({ resumable: null, lastJob: null })
          else if (lj && jp && e.where === 'pc' && jp.name === lj.name && jp.acked > 0 && jp.acked < lj.lines.length)
            set({ resumable: { ...lj, acked: jp.acked, pos: wp ? { x: wp.x, y: wp.y } : null } })
          set({ job: null })
          if (e.result === 'done' && jp?.name === 'material-test' && get().lastTest) {
            get().notify('ok', 'Test burned. Take a photo of it to rate it.')
            set({ testOpen: true })
          } else if (e.result === 'done') get().notify('ok', 'Job finished.')
          else get().notify('error', `Job ${e.result}${e.reason ? `: ${e.reason}` : ''}`)
          break
        }
      }
    },
  }
})

export async function initStore() {
  window.ember.onEvent((e) => {
    try {
      useStore.getState().handleEvent(e)
    } catch (err) {
      // One bad event must never leave the UI thinking a job is still running.
      console.error('event handler failed', err)
      if ((e as { type?: string }).type === 'jobEnd') useStore.setState({ job: null })
    }
  })
  const presets = (await window.ember.invoke('presets.load').catch(() => [])) as MaterialPreset[]
  useStore.setState({ userPresets: presets })
  if (isRemote()) {
    void fetch('/api/info').then((r) => r.json()).then((j) => useStore.setState({ me: j.me ?? null })).catch(() => undefined)
    void window.ember.invoke('admin.settings.get').then((a) => useStore.setState({ powerCap: (a as { powerCap: number }).powerCap })).catch(() => undefined)
  }
  void loadFonts().then(() => useStore.setState((st) => ({ assetVersion: st.assetVersion + 1 })))
}

export const ALL_PRESETS = () => [...BUILTIN_PRESETS, ...useStore.getState().userPresets]
void rectPath
void getAsset
