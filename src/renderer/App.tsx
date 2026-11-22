import { useEscape } from './lib/useEscape'
import { useEffect, useRef, useState } from 'react'
import { useStore, type Tab } from './store'
import { DesignView } from './DesignView'
import { PreviewView, fmtTime } from './PreviewView'
import { DeviceView } from './DeviceView'
import { SendDialog } from './SendDialog'

const TABS: { id: Tab; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'preview', label: 'Preview' },
  { id: 'device', label: 'Device' },
]

function JobBar() {
  const job = useStore((s) => s.job)
  const status = useStore((s) => s.status)
  const { api } = useStore.getState()
  if (!job) return null
  const pct = Math.round((job.acked / Math.max(1, job.total)) * 100)
  const paused = job.state === 'paused'
  return (
    <div className="jobbar">
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      <b>{job.name}</b>
      <span>{pct}%{job.etaMs ? ` · ${fmtTime(job.etaMs / 1000)} left` : ''}</span>
      <span className="dim">{job.where === 'device' ? 'running on ESP32' : status?.state}</span>
      <div className="spacer" />
      {paused ? <button onClick={() => api('job.resume')}>▶ Resume</button> : <button onClick={() => api('job.pause')}>⏸ Pause</button>}
      <button className="danger" onClick={() => api('job.stop')}>■ Stop</button>
    </div>
  )
}

function MachineDialog({ onClose }: { onClose: () => void }) {
  const m = useStore((s) => s.machine)
  const profiles = useStore((s) => s.profiles)
  const { setMachine, selectMachine, deleteMachine } = useStore.getState()
  const [v, setV] = useState({ ...m })
  const num = (k: keyof typeof v, label: string, unit: string) => (
    <label className="field">
      <span>{label} ({unit})</span>
      <input type="number" value={v[k] as number} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
    </label>
  )
  const valid = v.bedWidth > 10 && v.bedHeight > 10 && v.maxS > 0 && v.maxSpeed > 0
  useEscape(onClose)
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Machine</h2>
        <div className="num">
          <select value={profiles.some((p) => p.id === v.id) ? v.id : ''} onChange={(e) => { const p = profiles.find((x) => x.id === e.target.value); if (p) (selectMachine(p.id), setV({ ...p })) }}>
            {!profiles.some((p) => p.id === v.id) && <option value="">New machine (unsaved)</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button title="Add another machine, starting from the values below" onClick={() => setV({ ...v, id: 'm_' + Date.now().toString(36), name: 'New machine' })}>＋ New</button>
          <button title="Remove this machine" disabled={profiles.length < 2 || !profiles.some((p) => p.id === v.id)} onClick={() => { deleteMachine(v.id); setV({ ...useStore.getState().machine }) }}>Delete</button>
        </div>
        <label className="field"><span>Name</span><input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <div className="grid2">
          {num('bedWidth', 'Work area width', 'mm')}
          {num('bedHeight', 'Work area height', 'mm')}
          {num('maxS', 'Laser power scale ($30)', 'max S')}
          {num('maxSpeed', 'Max speed', 'mm/s')}
          {num('baud', 'Default baud', 'bps')}
        </div>
        <label className="field">
          <span>Machine origin (0,0) is at the</span>
          <select value={v.originCorner} onChange={(e) => setV({ ...v, originCorner: e.target.value as typeof v.originCorner })}>
            <option value="bl">front-left (bottom-left)</option>
            <option value="br">front-right</option>
            <option value="tl">back-left</option>
            <option value="tr">back-right</option>
          </select>
        </label>
        <p className="hint">Only matters for "same place as on the bed" jobs. The default is the Creality Falcon2 12W.</p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={() => (setMachine(v), onClose())}>Save</button>
        </div>
      </div>
    </div>
  )
}

function Toast() {
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => useStore.setState({ toast: null }), toast.kind === 'error' ? 8000 : 4000)
    return () => clearTimeout(t)
  }, [toast])
  if (!toast) return null
  return (
    <div className={'toast ' + toast.kind} onClick={() => useStore.setState({ toast: null })}>
      {toast.text}
    </div>
  )
}

function UpdateBar() {
  const u = useStore((s) => s.update)
  const { api } = useStore.getState()
  const [hidden, setHidden] = useState(false)
  if (!u || !u.enabled) return null
  const working = u.phase === 'downloading' || u.phase === 'installing' || u.phase === 'restarting'
  if (!working && (!u.available || hidden) && u.phase !== 'error') return null
  return (
    <div className="updatebar">
      {working ? (
        <span>{u.message || 'Updating…'}</span>
      ) : u.phase === 'error' ? (
        <>
          <span>{u.message}</span>
          <div className="spacer" />
          <button onClick={() => setHidden(true)}>Dismiss</button>
        </>
      ) : (
        <>
          <span>
            <b>Ember {u.latest}</b> is available (this box has {u.current}).
          </span>
          <div className="spacer" />
          <label className="inline" title="Install new versions by itself when the laser is idle">
            <input type="checkbox" checked={u.auto} onChange={(e) => void api('update.auto', { on: e.target.checked })} /> Install automatically
          </label>
          <button onClick={() => setHidden(true)}>Later</button>
          <button className="primary" onClick={() => void api('update.apply')}>Install now</button>
        </>
      )}
    </div>
  )
}

export function App() {
  const tab = useStore((s) => s.tab)
  const conn = useStore((s) => s.conn)
  const status = useStore((s) => s.status)
  const fileName = useStore((s) => s.fileName)
  const raw = useStore((s) => s.raw)
  const objs = useStore((s) => s.doc.objects.length)
  const { setTab, openSend, generate, api, undo, redo, newProject, saveProject, importFiles } = useStore.getState()
  const openRef = useRef<HTMLInputElement>(null)
  const [machineOpen, setMachineOpen] = useState(false)
  const machineName = useStore((s) => s.machine.name)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? redo() : undo())
      else if (mod && e.key.toLowerCase() === 'y') (e.preventDefault(), redo())
      else if (mod && e.key.toLowerCase() === 'd') (e.preventDefault(), s.duplicateSelected())
      else if (mod && e.key.toLowerCase() === 's') (e.preventDefault(), void saveProject())
      else if (mod && e.key.toLowerCase() === 'a' && s.tab === 'design') (e.preventDefault(), s.select(s.doc.objects.map((o) => o.id)))
      else if (e.key === 'Delete' || e.key === 'Backspace') s.removeSelected()
      else if (s.tab === 'design' && !mod) {
        const k = e.key.toLowerCase()
        if (k === 'v') s.setTool('select')
        else if (k === 'r') s.setTool('rect')
        else if (k === 'e') s.setTool('ellipse')
        else if (k === 't') (s.addText(), s.setTool('select'))
        else if (k.startsWith('arrow') && s.selection.length) {
          e.preventDefault()
          const d = e.shiftKey ? 10 : 1
          const dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0
          const dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0
          for (const id of s.selection) {
            const o = s.doc.objects.find((x) => x.id === id)
            if (o) s.updateObject(id, { x: o.x + dx, y: o.y + dy })
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, saveProject])

  // Dropping a file anywhere outside the canvas should not navigate the window.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => (window.removeEventListener('dragover', stop), window.removeEventListener('drop', stop))
  }, [])

  const state = status?.state ?? 'Disconnected'
  const canSend = objs > 0 || !!raw

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo"><span>🔥</span> Ember</div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => {
                setTab(t.id)
                if (t.id === 'preview') void generate()
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="file">
          <button onClick={newProject} title="New project">New</button>
          <button onClick={() => void saveProject()} title="Save project (Ctrl+S)">Save</button>
          <button onClick={() => openRef.current?.click()} title="Open a project, SVG, image or G-code file">Open</button>
          <input ref={openRef} type="file" hidden multiple accept=".svg,.png,.jpg,.jpeg,.webp,.bmp,.gif,.nc,.gcode,.gc,.ngc,.txt,.ember" onChange={(e) => (void importFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
          <span className="name">{raw ? raw.name : fileName}</span>
        </div>
        <div className="spacer" />
        <button className="ghost" onClick={() => setMachineOpen(true)} title="Machine settings">⚙ {machineName}</button>
        <button className={'chip st-' + state} onClick={() => setTab('device')} title="Open device tab">
          <i /> {conn.connected ? `${conn.label ?? 'Connected'} · ${state}` : 'Not connected'}
        </button>
        {conn.connected && (
          <button className="estop" title="Emergency stop: resets the controller immediately" onClick={() => api('estop')}>
            STOP
          </button>
        )}
        <button
          className="primary"
          disabled={!canSend}
          onClick={async () => {
            await generate()
            setTab('preview')
            openSend(true)
          }}
        >
          Send ▸
        </button>
      </header>
      <main>
        {tab === 'design' && <DesignView />}
        {tab === 'preview' && <PreviewView />}
        {tab === 'device' && <DeviceView />}
      </main>
      <UpdateBar />
      <JobBar />
      <SendDialog />
      {machineOpen && <MachineDialog onClose={() => setMachineOpen(false)} />}
      <Toast />
    </div>
  )
}
