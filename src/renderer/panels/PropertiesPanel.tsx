import { useState } from 'react'
import { useStore } from '../store'
import { DEFAULT_TRACE, type TraceOptions } from '../../core/raster/trace'
import { objectBounds, type DesignObject } from '../../core/document'
import { assetProvider } from '../lib/assets'
import { FONT_LIST } from '../lib/fonts'
import { LayerBody } from './LayersPanel'
import type { LayerSettings } from '../../core/types'

/** What should this object do? Picks which layer (and so which settings) it lives on. */
function Operation({ layers, value, onPick }: { layers: LayerSettings[]; value: string; onPick: (id: string) => void }) {
  return (
    <div className="ops">
      {layers.map((l) => (
        <button key={l.id} className={l.id === value ? 'on' : ''} style={l.id === value ? { borderColor: l.color } : undefined} onClick={() => onPick(l.id)} title={l.mode === 'line' ? 'Follow the outline' : 'Fill with lines'}>
          <i style={{ background: l.color }} />
          {l.name}
        </button>
      ))}
    </div>
  )
}


function N({ label, value, onChange, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="field small">
      <span>{label}</span>
      <input type="number" step={step} value={Number.isFinite(value) ? Math.round(value * 100) / 100 : ''} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))} />
    </label>
  )
}

function TracePanel({ id }: { id: string }) {
  const [o, setO] = useState<TraceOptions>(DEFAULT_TRACE)
  const [keep, setKeep] = useState(false)
  const traceImage = useStore((s) => s.traceImage)
  return (
    <div className="subpanel">
      <h4>Trace to vectors</h4>
      <p className="hint">Turns the picture into cuttable lines.</p>
      <div className="row-between">
        <label className="check"><input type="radio" checked={o.mode === 'outline'} onChange={() => setO({ ...o, mode: 'outline' })} />Outline</label>
        <label className="check"><input type="radio" checked={o.mode === 'centerline'} onChange={() => setO({ ...o, mode: 'centerline' })} />Centerline</label>
      </div>
      <label className="field"><span>Threshold {o.threshold}</span><input type="range" min={10} max={245} value={o.threshold} onChange={(e) => setO({ ...o, threshold: Number(e.target.value) })} /></label>
      <label className="field"><span>Detail {o.tolerance.toFixed(1)} (lower = more)</span><input type="range" min={0.2} max={4} step={0.1} value={o.tolerance} onChange={(e) => setO({ ...o, tolerance: Number(e.target.value) })} /></label>
      <label className="field"><span>Ignore specks under {o.minArea}px</span><input type="range" min={0} max={200} value={o.minArea} onChange={(e) => setO({ ...o, minArea: Number(e.target.value) })} /></label>
      <label className="check"><input type="checkbox" checked={o.invert} onChange={(e) => setO({ ...o, invert: e.target.checked })} />Trace the light parts</label>
      <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep the original image</label>
      <button className="btn primary" onClick={() => traceImage(id, o, keep)}>Trace image</button>
    </div>
  )
}

export function PropertiesPanel() {
  const sel = useStore((s) => s.selection)
  const doc = useStore((s) => s.doc)
  const { updateObject, removeSelected, duplicateSelected } = useStore.getState()
  useStore((s) => s.assetVersion)

  if (!sel.length) {
    return (
      <section className="panel">
        <header><h3>How this works</h3></header>
        <ol className="steps">
          <li><b>Add</b> shapes, text, or drop in an SVG / picture.</li>
          <li><b>Click</b> it and choose what the laser does: Cut, Score or Engrave.</li>
          <li>Open <b>Preview</b> to see exactly what will burn.</li>
          <li>Press <b>Send</b> to run it.</li>
        </ol>
      </section>
    )
  }
  if (sel.length > 1) {
    const layerId = doc.objects.find((o) => o.id === sel[0])?.layerId
    return (
      <section className="panel">
        <header><h3>{sel.length} objects</h3></header>
        <span className="lbl">What should the laser do with these?</span>
        <Operation layers={doc.layers} value={layerId ?? ''} onPick={(id) => sel.forEach((oid) => updateObject(oid, { layerId: id }))} />
        <div className="row-between tools">
          <button onClick={duplicateSelected}>Duplicate</button>
          <button className="danger" onClick={removeSelected}>Delete</button>
        </div>
      </section>
    )
  }
  const o = doc.objects.find((x) => x.id === sel[0]) as DesignObject | undefined
  if (!o) return null
  const b = objectBounds(o, assetProvider)
  const w = b ? b.maxX - b.minX : 0
  const h = b ? b.maxY - b.minY : 0
  const setPos = (nx?: number, ny?: number) => {
    if (!b) return
    updateObject(o.id, { x: o.x + (nx !== undefined ? nx - b.minX : 0), y: o.y + (ny !== undefined ? ny - b.minY : 0) })
  }
  const setSize = (nw?: number, nh?: number, lock = false) => {
    if (!b || (nw !== undefined && nw <= 0) || (nh !== undefined && nh <= 0)) return
    let fx = nw !== undefined ? nw / w : 1
    let fy = nh !== undefined ? nh / h : 1
    if (lock) {
      if (nw !== undefined) fy = fx
      else fx = fy
    }
    updateObject(o.id, { scaleX: o.scaleX * fx, scaleY: o.scaleY * fy })
  }
  const layer = doc.layers.find((l) => l.id === o.layerId)
  const lock = (document.getElementById('lock-aspect') as HTMLInputElement | null)?.checked ?? true

  return (
    <section className="panel">
      <header>
        <h3>{o.type === 'text' ? 'Text' : o.type === 'image' ? 'Image' : o.shape === 'path' ? 'Vector' : o.name}</h3>
        <small>{o.name}</small>
      </header>
      <span className="lbl">What should the laser do?</span>
      <Operation layers={doc.layers} value={o.layerId} onPick={(id) => updateObject(o.id, { layerId: id })} />
      {layer && <LayerBody l={layer} simple />}
      <span className="lbl">Size and position</span>
      <div className="grid2">
        <N label="X (from left)" value={b?.minX ?? 0} onChange={(v) => setPos(v, undefined)} />
        <N label="Y (from top)" value={b?.minY ?? 0} onChange={(v) => setPos(undefined, v)} />
        <N label="Width" value={w} onChange={(v) => setSize(v, undefined, lock)} />
        <N label="Height" value={h} onChange={(v) => setSize(undefined, v, lock)} />
        <N label="Rotate °" value={o.rotation} step={1} onChange={(v) => updateObject(o.id, { rotation: v })} />
        <label className="check" style={{ alignSelf: 'end', paddingBottom: 6 }}>
          <input id="lock-aspect" type="checkbox" defaultChecked />Lock ratio
        </label>
      </div>
      {o.type === 'text' && (
        <>
          <label className="field">
            <span>Text</span>
            <textarea rows={2} value={o.text} onChange={(e) => updateObject(o.id, { text: e.target.value }, true)} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Font</span>
              <select value={o.fontFamily} onChange={(e) => updateObject(o.id, { fontFamily: e.target.value })}>
                {FONT_LIST.map((f) => <option key={f}>{f}</option>)}
              </select>
            </label>
            <N label="Size (mm)" value={o.fontSizeMm} onChange={(v) => v > 0 && updateObject(o.id, { fontSizeMm: v })} />
          </div>
          <div className="row-between">
            <label className="check"><input type="checkbox" checked={o.bold} onChange={(e) => updateObject(o.id, { bold: e.target.checked })} />Bold</label>
            <label className="check"><input type="checkbox" checked={o.italic} onChange={(e) => updateObject(o.id, { italic: e.target.checked })} />Italic</label>
          </div>
          <p className="hint">Text is real vector outlines: use a Line layer to cut or score it, or a Fill layer to engrave it solid.</p>
        </>
      )}
      {o.type === 'image' && (
        <>
          <label className="field">
            <span>Brightness {o.adjust.brightness}</span>
            <input type="range" min={-100} max={100} value={o.adjust.brightness} onChange={(e) => updateObject(o.id, { adjust: { ...o.adjust, brightness: Number(e.target.value) } }, true)} />
          </label>
          <label className="field">
            <span>Contrast {o.adjust.contrast}</span>
            <input type="range" min={-100} max={100} value={o.adjust.contrast} onChange={(e) => updateObject(o.id, { adjust: { ...o.adjust, contrast: Number(e.target.value) } }, true)} />
          </label>
          <label className="check"><input type="checkbox" checked={o.adjust.invert} onChange={(e) => updateObject(o.id, { adjust: { ...o.adjust, invert: e.target.checked } })} />Invert (engrave the light parts)</label>
          <p className="hint">See the dithered result in Preview before you burn.</p>
          <TracePanel id={o.id} />
        </>
      )}
      <div className="row-between tools">
        <button onClick={duplicateSelected}>Duplicate</button>
        <button className="danger" onClick={removeSelected}>Delete</button>
      </div>
    </section>
  )
}
