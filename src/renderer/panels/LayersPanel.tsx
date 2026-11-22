import { useState } from 'react'
import { ALL_PRESETS, useStore } from '../store'
import type { LayerSettings } from '../../core/types'

function Num({ label, value, onChange, min, max, step = 1, unit }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="num">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) onChange(min !== undefined && max !== undefined ? Math.max(min, Math.min(max, v)) : v)
          }}
        />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  )
}

export const fmtSpeed = (mmPerS: number, unit: 'mm/s' | 'mm/min') => (unit === 'mm/min' ? Math.round(mmPerS * 60) : Math.round(mmPerS * 10) / 10)

export function layerSummary(l: LayerSettings, unit: 'mm/s' | 'mm/min') {
  return `${l.mode === 'line' ? 'Line' : 'Fill'} · ${fmtSpeed(l.speed, unit)} ${unit} · ${l.power}%${l.passes > 1 ? ` · ${l.passes} passes` : ''}`
}

/** Editable settings for one layer. `simple` shows only speed, power, passes and the material preset. */
export function LayerBody({ l, simple = false }: { l: LayerSettings; simple?: boolean }) {
  const { setLayer, applyPreset, saveLayerAsPreset } = useStore.getState()
  const objects = useStore((s) => s.doc.objects)
  useStore((s) => s.userPresets)
  const unit = useStore((s) => s.speedUnit)
  const [more, setMore] = useState(false)
  const hasRaster = objects.some((o) => o.layerId === l.id && (o.type === 'image' || o.type === 'text'))
  const presets = ALL_PRESETS()
  const showMore = !simple || more
  const toDisplay = (v: number) => (unit === 'mm/min' ? Math.round(v * 60) : Math.round(v * 100) / 100)
  const fromDisplay = (v: number) => (unit === 'mm/min' ? v / 60 : v)
  return (
    <div className="layer-body">
      <select
        className="preset"
        value=""
        onChange={(e) => {
          const p = presets.find((x) => x.id === e.target.value)
          if (p) applyPreset(l.id, p)
        }}
      >
        <option value="">Pick a material to fill these in…</option>
        {[...new Set(presets.map((p) => p.material))].map((m) => (
          <optgroup key={m} label={m}>
            {presets.filter((p) => p.material === m).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="grid3">
        <label className="field">
          <span>
            Speed{' '}
            <button className="unit" title="Switch between mm/min and mm/s" onClick={() => useStore.getState().setSpeedUnit(unit === 'mm/min' ? 'mm/s' : 'mm/min')}>{unit}</button>
          </span>
          <div className="num">
            <input type="number" value={toDisplay(l.speed)} min={0} onChange={(e) => { const v = fromDisplay(Number(e.target.value)); if (Number.isFinite(v) && v > 0) setLayer(l.id, { speed: Math.min(v, 500) }) }} />
          </div>
        </label>
        <Num label="Power %" value={l.power} min={0} max={100} onChange={(v) => setLayer(l.id, { power: v })} />
        <Num label="Passes" value={l.passes} min={1} max={50} onChange={(v) => setLayer(l.id, { passes: Math.round(v) })} />
      </div>
      {simple && (
        <button className="ghost small" onClick={() => setMore(!more)}>{more ? '▾ Fewer settings' : '▸ More settings'}</button>
      )}
      {showMore && (
        <>
          <div className="seg">
            <button className={l.mode === 'line' ? 'on' : ''} onClick={() => setLayer(l.id, { mode: 'line' })} title="Follow the outlines (for cutting and scoring)">Outline</button>
            <button className={l.mode === 'fill' ? 'on' : ''} onClick={() => setLayer(l.id, { mode: 'fill' })} title="Fill the shapes with lines (for engraving)">Fill</button>
          </div>
          <div className="grid2">
            {(l.mode === 'fill' || hasRaster) && <Num label="Line gap (mm)" step={0.01} value={l.lineInterval} min={0.02} max={2} onChange={(v) => setLayer(l.id, { lineInterval: v })} />}
            {l.mode === 'fill' && <Num label="Hatch angle °" value={l.fillAngle} min={0} max={179} onChange={(v) => setLayer(l.id, { fillAngle: v })} />}
          </div>
          {(l.mode === 'fill' || hasRaster) && (
            <>
              <label className="field">
                <span>Pictures are burned as</span>
                <select value={l.dither} onChange={(e) => setLayer(l.id, { dither: e.target.value as LayerSettings['dither'] })}>
                  <option value="floyd">Dots: Floyd–Steinberg (photos)</option>
                  <option value="atkinson">Dots: Atkinson (crisp)</option>
                  <option value="bayer">Dots: Ordered</option>
                  <option value="threshold">Black &amp; white (logos)</option>
                  <option value="grayscale">Grayscale (variable power)</option>
                </select>
              </label>
              {l.dither === 'threshold' && <Num label="Threshold" value={l.threshold} min={1} max={254} onChange={(v) => setLayer(l.id, { threshold: v })} />}
              {l.dither === 'grayscale' && <Num label="Min power %" value={l.minPower} min={0} max={100} onChange={(v) => setLayer(l.id, { minPower: v })} />}
            </>
          )}
          <div className="row-between">
            <label className="check"><input type="checkbox" checked={l.airAssist} onChange={(e) => setLayer(l.id, { airAssist: e.target.checked })} />Air assist</label>
            {l.mode === 'line' && <label className="check"><input type="checkbox" checked={l.innerFirst} onChange={(e) => setLayer(l.id, { innerFirst: e.target.checked })} />Holes first</label>}
            {(l.mode === 'fill' || hasRaster) && <label className="check"><input type="checkbox" checked={l.bidirectional} onChange={(e) => setLayer(l.id, { bidirectional: e.target.checked })} />Both directions</label>}
          </div>
          <button
            className="ghost small"
            onClick={() => {
              const name = prompt('Name this preset', `${l.name} ${fmtSpeed(l.speed, unit)}${unit} ${l.power}%`)
              if (name) saveLayerAsPreset(l.id, name)
            }}
          >
            Save these as a preset
          </button>
        </>
      )}
    </div>
  )
}

function LayerCard({ l, index, count }: { l: LayerSettings; index: number; count: number }) {
  const { setLayer, removeLayer, moveLayer } = useStore.getState()
  const objects = useStore((s) => s.doc.objects)
  const unit = useStore((s) => s.speedUnit)
  const [open, setOpen] = useState(false)
  const n = objects.filter((o) => o.layerId === l.id).length
  return (
    <div className="layer-card">
      <div className="layer-head" onClick={() => setOpen(!open)}>
        <input type="color" value={l.color} onClick={(e) => e.stopPropagation()} onChange={(e) => setLayer(l.id, { color: e.target.value })} title="Layer colour" />
        <div className="layer-title">
          <input className="layer-name" value={l.name} onClick={(e) => e.stopPropagation()} onChange={(e) => setLayer(l.id, { name: e.target.value })} />
          <small>{layerSummary(l, unit)}</small>
        </div>
        <small title="Objects on this layer">{n}</small>
        <button className={'icon' + (l.visible ? '' : ' off')} title="Show / hide" onClick={(e) => (e.stopPropagation(), setLayer(l.id, { visible: !l.visible }))}>{l.visible ? '👁' : '◌'}</button>
        <button className={'icon' + (l.output ? '' : ' off')} title={l.output ? 'Will be burned. Click to skip this layer' : 'Skipped. Click to burn this layer'} onClick={(e) => (e.stopPropagation(), setLayer(l.id, { output: !l.output }))}>🔥</button>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <>
          <LayerBody l={l} />
          <div className="row-between tools" style={{ padding: '0 8px 8px' }}>
            <button onClick={() => moveLayer(l.id, -1)} disabled={index === 0} title="Burn earlier">↑ Earlier</button>
            <button onClick={() => moveLayer(l.id, 1)} disabled={index === count - 1} title="Burn later">↓ Later</button>
            <button className="danger" onClick={() => removeLayer(l.id)}>Delete</button>
          </div>
        </>
      )}
    </div>
  )
}

export function LayersPanel() {
  const layers = useStore((s) => s.doc.layers)
  const addLayer = useStore((s) => s.addLayer)
  return (
    <section className="panel">
      <header>
        <h3>Layers</h3>
        <small>burned top to bottom</small>
        <button className="ghost" onClick={addLayer}>+ Layer</button>
      </header>
      {layers.map((l, i) => (
        <LayerCard key={l.id} l={l} index={i} count={layers.length} />
      ))}
    </section>
  )
}
