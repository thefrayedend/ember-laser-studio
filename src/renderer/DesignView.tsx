import { useEscape } from './lib/useEscape'
import { useRef, useState } from 'react'
import { DesignCanvas } from './DesignCanvas'
import { LayersPanel } from './panels/LayersPanel'
import { PropertiesPanel } from './panels/PropertiesPanel'
import { useStore, type Tool } from './store'

const TOOLS: { id: Tool; label: string; glyph: string }[] = [
  { id: 'select', label: 'Select (V)', glyph: '⬉' },
  { id: 'rect', label: 'Rectangle (R)', glyph: '▭' },
  { id: 'ellipse', label: 'Ellipse (E)', glyph: '◯' },
  { id: 'polygon', label: 'Hexagon', glyph: '⬡' },
  { id: 'star', label: 'Star', glyph: '☆' },
  { id: 'text', label: 'Text (T)', glyph: 'T' },
]

function TestGridDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  const unit = useStore((s) => s.speedUnit)
  const [kind, setKind] = useState<'engrave' | 'cut'>('engrave')
  const per = unit === 'mm/min' ? 1 : 1 / 60
  const defaults = {
    engrave: { speeds: [2000, 3000, 4000, 5000, 6000].map((v) => Math.round(v * per)), powers: [20, 30, 40, 50, 60] },
    cut: { speeds: [100, 200, 300, 400, 600].map((v) => Math.round(v * per * 10) / 10), powers: [70, 85, 100] },
  }
  const [speeds, setSpeeds] = useState(defaults.engrave.speeds.join(', '))
  const [powers, setPowers] = useState(defaults.engrave.powers.join(', '))
  const [err, setErr] = useState('')
  const pick = (k: 'engrave' | 'cut') => (setKind(k), setSpeeds(defaults[k].speeds.join(', ')), setPowers(defaults[k].powers.join(', ')))
  const parse = (s: string) => s.split(/[,\s]+/).filter(Boolean).map(Number)
  const go = () => {
    const sp = parse(speeds)
    const pw = parse(powers)
    if (!sp.length || !pw.length || [...sp, ...pw].some((n) => !Number.isFinite(n) || n <= 0)) return setErr('Use positive numbers separated by commas.')
    if (pw.some((p) => p > 100)) return setErr('Power is a percentage, 1–100.')
    if (sp.length * pw.length > 100) return setErr('Too many cells (max 100).')
    void useStore.getState().makeTestGrid(sp.map((v) => v / (unit === 'mm/min' ? 60 : 1)), pw, kind)
    onClose()
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Material test</h2>
        <p className="hint">Not sure what settings your material needs? Burn this on a scrap piece. Speed changes across the columns and power down the rows. Pick the square that looks best.</p>
        <div className="seg">
          <button className={kind === 'engrave' ? 'on' : ''} onClick={() => pick('engrave')}>Engraving squares</button>
          <button className={kind === 'cut' ? 'on' : ''} onClick={() => pick('cut')}>Cutting squares</button>
        </div>
        <label className="field"><span>Speeds ({unit}), one per column</span><input value={speeds} onChange={(e) => setSpeeds(e.target.value)} /></label>
        <label className="field"><span>Powers (%), one per row</span><input value={powers} onChange={(e) => setPowers(e.target.value)} /></label>
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={go}>Build test</button>
        </div>
      </div>
    </div>
  )
}

export function DesignView() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const importFiles = useStore((s) => s.importFiles)
  const addText = useStore((s) => s.addText)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [grid, setGrid] = useState(false)
  const objCount = useStore((s) => s.doc.objects.length)

  return (
    <div
      className="design"
      onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void importFiles([...e.dataTransfer.files])
      }}
    >
      <div className="toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'on' : ''} title={t.label} onClick={() => (t.id === 'text' ? (addText(), setTool('select')) : setTool(t.id))}>
            <span>{t.glyph}</span>
          </button>
        ))}
        <div className="sep" />
        <button title="Import SVG, image or G-code" onClick={() => fileRef.current?.click()}><span>⤓</span></button>
        <input ref={fileRef} type="file" hidden multiple accept=".svg,.png,.jpg,.jpeg,.webp,.bmp,.gif,.nc,.gcode,.gc,.ngc,.txt,.ember" onChange={(e) => (void importFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
        <div className="sep" />
        <button title="Material test grid" onClick={() => setGrid(true)}><span>▦</span></button>
        <button title="Rate a burned test with a photo / past tests" onClick={() => useStore.getState().setTestOpen(true)}><span>◩</span></button>
      </div>
      <div className="stage">
        <DesignCanvas />
        {objCount === 0 && (
          <div className="empty-hint">
            <h2>Start a design</h2>
            <p>Drop an SVG, image or G-code file here, or pick a shape on the left.</p>
            <button className="primary" onClick={() => fileRef.current?.click()}>Import a file</button>
          </div>
        )}
        {dragOver && <div className="drop">Drop to import</div>}
      </div>
      <aside className="sidebar">
        <PropertiesPanel />
        <LayersPanel />
      </aside>
      {grid && <TestGridDialog onClose={() => setGrid(false)} />}
    </div>
  )
}
