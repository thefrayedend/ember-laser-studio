import { useEscape } from './lib/useEscape'
import { useRef, useState } from 'react'
import { DesignCanvas } from './DesignCanvas'
import { LayersPanel } from './panels/LayersPanel'
import { PropertiesPanel } from './panels/PropertiesPanel'
import { useStore, type Tool } from './store'
import { TESTS, type TestId } from '../core/test/suites'

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
  const [id, setId] = useState<TestId>('engrave')
  const meta = TESTS.find((t) => t.id === id)!
  const per = unit === 'mm/min' ? 1 : 1 / 60
  const r1 = (v: number) => Math.round(v * 10) / 10
  const defaults: Record<string, { speeds: number[]; powers: number[]; speed: number; power: number }> = {
    engrave: { speeds: [2000, 3000, 4000, 5000, 6000].map((v) => r1(v * per)), powers: [20, 30, 40, 50, 60], speed: r1(4000 * per), power: 40 },
    cut: { speeds: [100, 200, 300, 400, 600].map((v) => r1(v * per)), powers: [70, 85, 100], speed: r1(300 * per), power: 100 },
    marking: { speeds: [3000, 6000, 9000].map((v) => r1(v * per)), powers: [5, 10, 15, 20], speed: r1(6000 * per), power: 10 },
    air: { speeds: [3000, 4500, 6000].map((v) => r1(v * per)), powers: [30, 45, 60], speed: r1(4000 * per), power: 40 },
  }
  const d = (k: string) => defaults[k] ?? (['passes', 'kerf'].includes(k) ? defaults.cut : defaults.engrave)
  const [speeds, setSpeeds] = useState(d('engrave').speeds.join(', '))
  const [powers, setPowers] = useState(d('engrave').powers.join(', '))
  const [speed, setSpeed] = useState(String(d('engrave').speed))
  const [power, setPower] = useState(String(d('engrave').power))
  const [thick, setThick] = useState('3')
  const [err, setErr] = useState('')
  const pick = (k: TestId) => {
    setId(k)
    setSpeeds(d(k).speeds.join(', '))
    setPowers(d(k).powers.join(', '))
    setSpeed(String(d(k).speed))
    setPower(String(d(k).power))
    setErr('')
  }
  const parse = (s: string) => s.split(/[,\s]+/).filter(Boolean).map(Number)
  const go = () => {
    const sp = parse(speeds)
    const pw = parse(powers)
    const one = Number(speed)
    const onep = Number(power)
    const t = Number(thick)
    if (meta.fields.includes('speeds') && (!sp.length || sp.some((n) => !Number.isFinite(n) || n <= 0))) return setErr('Speeds: positive numbers separated by commas.')
    if (meta.fields.includes('powers') && (!pw.length || pw.some((n) => !Number.isFinite(n) || n <= 0 || n > 100))) return setErr('Powers are percentages, 1–100, separated by commas.')
    if (meta.fields.includes('speed') && !(one > 0)) return setErr('Speed must be a positive number.')
    if (meta.fields.includes('power') && !(onep > 0 && onep <= 100)) return setErr('Power is a percentage, 1–100.')
    if (meta.fields.includes('thickness') && !(t > 0.2 && t < 20)) return setErr('Thickness is in mm.')
    if (sp.length * pw.length > 100) return setErr('Too many cells (max 100).')
    const toS = (v: number) => v / (unit === 'mm/min' ? 60 : 1)
    void useStore.getState().makeTest(id, { speeds: sp.map(toS), powers: pw, speed: toS(one), power: onep, thickness: t })
    onClose()
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Material tests</h2>
        <label className="field">
          <span>Which test</span>
          <select value={id} onChange={(e) => pick(e.target.value as TestId)}>
            {TESTS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <p className="hint">{meta.blurb} Burn it on a scrap of the same material. When it finishes, Ember offers to rate it from a photo.</p>
        {meta.fields.includes('speeds') && <label className="field"><span>Speeds ({unit}), one per column</span><input value={speeds} onChange={(e) => setSpeeds(e.target.value)} /></label>}
        {meta.fields.includes('powers') && <label className="field"><span>Powers (%), one per row</span><input value={powers} onChange={(e) => setPowers(e.target.value)} /></label>}
        {meta.fields.includes('speed') && <label className="field"><span>Speed ({unit})</span><input value={speed} onChange={(e) => setSpeed(e.target.value)} /></label>}
        {meta.fields.includes('power') && <label className="field"><span>Power (%)</span><input value={power} onChange={(e) => setPower(e.target.value)} /></label>}
        {meta.fields.includes('thickness') && <label className="field"><span>Material thickness (mm)</span><input value={thick} onChange={(e) => setThick(e.target.value)} /></label>}
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button onClick={() => (onClose(), useStore.getState().setHelpOpen('tests'))}>How this works</button>
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
