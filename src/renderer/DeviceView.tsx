import { LiveView } from './LiveView'
import { GrblClient } from '../core/grbl/client'
import { loadMacros, macroLines, saveMacros, type Macro } from './lib/macros'
import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { buildResume, findResumeLine } from '../core/gcode/resume'
import { fmtTime } from './PreviewView'

const SETTING_NAMES: Record<number, string> = {
  0: 'Step pulse (µs)', 1: 'Step idle delay (ms)', 2: 'Step port invert', 3: 'Direction port invert', 4: 'Step enable invert', 5: 'Limit pins invert', 6: 'Probe pin invert',
  10: 'Status report mask', 11: 'Junction deviation (mm)', 12: 'Arc tolerance (mm)', 13: 'Report inches', 20: 'Soft limits', 21: 'Hard limits', 22: 'Homing cycle', 23: 'Homing direction invert',
  24: 'Homing feed (mm/min)', 25: 'Homing seek (mm/min)', 26: 'Homing debounce (ms)', 27: 'Homing pull-off (mm)', 30: 'Max spindle / laser S value', 31: 'Min spindle S value', 32: 'Laser mode (1 = on)',
  100: 'X steps/mm', 101: 'Y steps/mm', 102: 'Z steps/mm', 110: 'X max rate (mm/min)', 111: 'Y max rate (mm/min)', 112: 'Z max rate (mm/min)', 120: 'X accel (mm/s²)', 121: 'Y accel (mm/s²)', 122: 'Z accel (mm/s²)',
  130: 'X max travel (mm)', 131: 'Y max travel (mm)', 132: 'Z max travel (mm)',
}

function Connect() {
  const conn = useStore((s) => s.conn)
  const machine = useStore((s) => s.machine)
  const { api } = useStore.getState()
  const [kind, setKind] = useState<'serial' | 'tcp' | 'websocket' | 'esp32' | 'simulator'>(() => (localStorage.getItem('ember.kind') as never) || 'serial')
  const [ports, setPorts] = useState<{ path: string; manufacturer?: string; friendlyName?: string }[]>([])
  const [port, setPort] = useState(localStorage.getItem('ember.port') ?? '')
  const [baud, setBaud] = useState(machine.baud)
  const [host, setHost] = useState(localStorage.getItem('ember.host') ?? '')
  const [tcpPort, setTcpPort] = useState(23)
  const [wsUrl, setWsUrl] = useState(localStorage.getItem('ember.ws') ?? 'ws://192.168.1.50:81')
  const [found, setFound] = useState<{ name: string; host: string; port: number }[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const p = (await api<typeof ports>('ports.list')) ?? []
    setPorts(p)
    if (!port && p[0]) setPort(p[0].path)
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async () => {
    setBusy(true)
    localStorage.setItem('ember.kind', kind)
    localStorage.setItem('ember.port', port)
    localStorage.setItem('ember.host', host)
    localStorage.setItem('ember.ws', wsUrl)
    const req =
      kind === 'serial' ? { kind, path: port, baud } : kind === 'tcp' ? { kind, host, port: tcpPort } : kind === 'websocket' ? { kind, url: wsUrl } : kind === 'esp32' ? { kind, host, port: 80 } : { kind }
    await api('connect', req)
    setBusy(false)
    if (kind === 'esp32') void api('device.attach')
  }

  if (conn.connected)
    return (
      <section className="panel">
        <header><h3>Connection</h3></header>
        <p className="conn-ok">● {conn.label}</p>
        <button onClick={() => api('disconnect')}>Disconnect</button>
      </section>
    )
  return (
    <section className="panel">
      <header><h3>Connect</h3></header>
      <div className="seg five">
        {([['serial', 'USB'], ['tcp', 'Telnet'], ['websocket', 'WebSocket'], ['esp32', 'ESP32'], ['simulator', 'Demo']] as const).map(([k, l]) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      {kind === 'serial' && (
        <>
          <label className="field">
            <span>Port</span>
            <div className="num">
              <select value={port} onChange={(e) => setPort(e.target.value)}>
                {!ports.length && <option value="">No ports found</option>}
                {ports.map((p) => <option key={p.path} value={p.path}>{p.path}{p.friendlyName ? ` (${p.friendlyName})` : p.manufacturer ? ` (${p.manufacturer})` : ''}</option>)}
              </select>
              <button onClick={refresh} title="Rescan">⟳</button>
            </div>
          </label>
          <label className="field">
            <span>Baud rate</span>
            <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
              {[9600, 57600, 115200, 230400, 250000, 460800, 921600].map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
        </>
      )}
      {kind === 'tcp' && (
        <div className="grid2">
          <label className="field"><span>Host</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" /></label>
          <label className="field"><span>Port</span><input type="number" value={tcpPort} onChange={(e) => setTcpPort(Number(e.target.value))} /></label>
        </div>
      )}
      {kind === 'websocket' && (
        <label className="field"><span>Address</span><input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="ws://192.168.1.50:81" /><small className="hint">For FluidNC, ESP3D and other Wi-Fi GRBL boards. Usually port 81.</small></label>
      )}
      {kind === 'esp32' && (
        <>
          <label className="field">
            <span>Address</span>
            <div className="num">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ember-laser.local or 192.168.1.50" />
              <button
                disabled={scanning}
                onClick={async () => {
                  setScanning(true)
                  setFound((await api<typeof found>('esp32.discover')) ?? [])
                  setScanning(false)
                }}
              >
                {scanning ? '…' : 'Scan'}
              </button>
            </div>
          </label>
          {found.map((f) => (
            <button key={f.name} className="found" onClick={() => setHost(f.host)}>{f.name} · {f.host}</button>
          ))}
          {!found.length && !scanning && <p className="hint">Scan finds bridges on your network, or type the address shown on the bridge's status page.</p>}
        </>
      )}
      {kind === 'simulator' && <p className="hint">A virtual GRBL machine for trying the app without a laser. Nothing is burned.</p>}
      <button className="primary" disabled={busy || (kind === 'serial' && !port) || ((kind === 'tcp' || kind === 'esp32') && !host) || (kind === 'websocket' && !wsUrl.trim())} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
    </section>
  )
}

function Jog() {
  const { api } = useStore.getState()
  const status = useStore((s) => s.status)
  const machine = useStore((s) => s.machine)
  const [step, setStep] = useState(10)
  const [feed, setFeed] = useState(100) // mm/s
  const job = useStore((s) => s.job)
  const disabled = !status || status.state === 'Disconnected' || !!job
  const go = (x: number, y: number) => api('jog', { x: x || undefined, y: y || undefined, feed: feed * 60 })
  const goZ = (z: number) => api('jog', { z, feed: Math.min(feed, 20) * 60 })
  const [armed, setArmed] = useState(false)
  const [pct, setPct] = useState(2)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const stopFire = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = undefined
  }
  useEffect(() => () => stopFire(), [])
  const startFire = () => {
    const fire = () => api('pulse', { pct, maxS: machine.maxS })
    void fire()
    timer.current = setInterval(fire, 350)
  }

  return (
    <section className="panel">
      <header><h3>Move</h3><small>X {status?.wpos.x.toFixed(2) ?? '–'} · Y {status?.wpos.y.toFixed(2) ?? '–'} · Z {status?.wpos.z.toFixed(2) ?? '–'}</small></header>
      <div className="jogpad">
        <span /><button disabled={disabled} onClick={() => go(0, step)}>▲</button><span />
        <button disabled={disabled} onClick={() => go(-step, 0)}>◀</button>
        <button disabled={disabled} title="Cancel jog" onClick={() => api('jogCancel')}>■</button>
        <button disabled={disabled} onClick={() => go(step, 0)}>▶</button>
        <span /><button disabled={disabled} onClick={() => go(0, -step)}>▼</button><span />
      </div>
      <div className="seg five">
        {[0.1, 1, 10, 50, 100].map((s) => <button key={s} className={step === s ? 'on' : ''} onClick={() => setStep(s)}>{s}</button>)}
      </div>
      <div className="grid2 btns">
        <button disabled={disabled} title="Move Z up (focus)" onClick={() => goZ(step > 10 ? 10 : step)}>Z ▲</button>
        <button disabled={disabled} title="Move Z down (focus)" onClick={() => goZ(-(step > 10 ? 10 : step))}>Z ▼</button>
      </div>
      <label className="field"><span>Jog speed {feed} mm/s</span><input type="range" min={5} max={300} value={feed} onChange={(e) => setFeed(Number(e.target.value))} /></label>
      <div className="grid2 btns">
        <button disabled={disabled} onClick={() => api('home')}>⌂ Home</button>
        <button disabled={disabled} onClick={() => api('zero')} title="Make the current head position X0 Y0">Set origin here</button>
        <button disabled={disabled} onClick={() => api('goto', { x: 0, y: 0 })}>Go to origin</button>
        <button disabled={disabled} onClick={() => api('unlock')}>Unlock</button>
      </div>
      <div className="fire">
        <label className="check"><input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />Enable aiming laser (eye protection on)</label>
        {armed && (
          <>
            <label className="field"><span>Aim power {pct}%</span><input type="range" min={1} max={10} value={pct} onChange={(e) => setPct(Number(e.target.value))} /></label>
            <button className="fire-btn" disabled={disabled} onPointerDown={startFire} onPointerUp={stopFire} onPointerLeave={stopFire} onBlur={stopFire}>Hold to fire</button>
            <p className="hint">Fires short pulses only while held, so it can never stay on by accident.</p>
          </>
        )}
      </div>
    </section>
  )
}

function Overrides() {
  const status = useStore((s) => s.status)
  const { api } = useStore.getState()
  const [feed, setFeed] = useState(100)
  const [pow, setPow] = useState(100)
  const t = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const send = (kind: 'feed' | 'spindle', v: number) => {
    clearTimeout(t.current[kind])
    t.current[kind] = setTimeout(() => api('override', { kind, pct: v }), 120)
  }
  const ov = status?.overrides
  return (
    <section className="panel">
      <header><h3>Live adjust</h3><small>speed {ov?.feed ?? 100}% · power {ov?.spindle ?? 100}%</small></header>
      <label className="field"><span>Speed {feed}%</span><input type="range" min={10} max={200} value={feed} onChange={(e) => (setFeed(Number(e.target.value)), send('feed', Number(e.target.value)))} /></label>
      <label className="field"><span>Power {pow}%</span><input type="range" min={10} max={200} value={pow} onChange={(e) => (setPow(Number(e.target.value)), send('spindle', Number(e.target.value)))} /></label>
      <button onClick={() => (setFeed(100), setPow(100), api('override', { kind: 'feed', pct: 100 }), api('override', { kind: 'spindle', pct: 100 }))}>Reset to 100%</button>
    </section>
  )
}

function Console() {
  const lines = useStore((s) => s.console)
  const { api } = useStore.getState()
  const [text, setText] = useState('')
  const [hist, setHist] = useState<string[]>([])
  const [hi, setHi] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines.length])
  const submit = () => {
    const t = text.trim()
    if (!t) return
    void api('send', { text: t })
    setHist([t, ...hist.slice(0, 49)])
    setHi(-1)
    setText('')
  }
  return (
    <section className="panel console">
      <header><h3>Console</h3><button className="ghost" onClick={() => useStore.setState({ console: [] })}>Clear</button></header>
      <div className="log" ref={ref}>
        {lines.map((l) => <div key={l.id} className={l.dir}>{l.dir === 'tx' ? '> ' : ''}{l.text}</div>)}
      </div>
      <div className="num">
        <input
          value={text}
          placeholder="G-code or $ command, Enter to send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'ArrowUp') (e.preventDefault(), setHi(Math.min(hist.length - 1, hi + 1)), setText(hist[Math.min(hist.length - 1, hi + 1)] ?? ''))
            else if (e.key === 'ArrowDown') (e.preventDefault(), setHi(Math.max(-1, hi - 1)), setText(hist[hi - 1] ?? ''))
          }}
        />
        <button onClick={submit}>Send</button>
      </div>
    </section>
  )
}

function GrblSettings() {
  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const { api } = useStore.getState()
  const [edit, setEdit] = useState<Record<number, string>>({})
  const ids = Object.keys(settings).map(Number).sort((a, b) => a - b)
  return (
    <section className="panel">
      <header><h3>GRBL settings</h3><button className="ghost" disabled={!conn.connected} onClick={() => api('settings.request')}>Read from machine</button></header>
      {!ids.length && <p className="hint">Press "Read from machine" to load the $ settings.</p>}
      {settings[32] === '0' && <p className="warn">Laser mode is off. Set $32 to 1 before burning.</p>}
      <div className="settings">
        {ids.map((id) => (
          <div key={id} className="srow">
            <code>${id}</code>
            <span>{SETTING_NAMES[id] ?? 'Setting'}</span>
            <input value={edit[id] ?? settings[id]} onChange={(e) => setEdit({ ...edit, [id]: e.target.value })} />
            <button
              disabled={edit[id] === undefined || edit[id] === settings[id]}
              onClick={async () => {
                await api('settings.write', { id, value: edit[id] })
                setEdit(({ [id]: _, ...rest }) => rest)
              }}
            >
              Save
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function DeviceFiles() {
  const conn = useStore((s) => s.conn)
  const { api } = useStore.getState()
  const [files, setFiles] = useState<{ name: string; size: number }[]>([])
  const refresh = async () => setFiles(((await api<{ name: string; size: number }[]>('device.files')) ?? []))
  useEffect(() => {
    if (conn.deviceJobs) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.deviceJobs])
  if (!conn.deviceJobs) return null
  return (
    <section className="panel">
      <header><h3>Jobs on the ESP32</h3><button className="ghost" onClick={refresh}>Refresh</button></header>
      {!files.length && <p className="hint">No saved jobs. Jobs you send with "ESP32" appear here so you can run them again.</p>}
      {files.map((f) => (
        <div key={f.name} className="frow">
          <span>{f.name}<small> {(f.size / 1024).toFixed(0)} KB</small></span>
          <button onClick={() => api('device.run', { name: f.name })}>Run</button>
          <button className="danger" onClick={async () => (await api('device.remove', { name: f.name }), refresh())}>✕</button>
        </div>
      ))}
    </section>
  )
}

export function DeviceView() {
  const status = useStore((s) => s.status)
  const job = useStore((s) => s.job)
  const alarm = useStore((s) => s.alarm)
  const raw = useStore((s) => s.raw)
  const { api, makeFrameLines, notify } = useStore.getState()
  const mp = status?.mpos
  return (
    <div className="device">
      <aside className="sidebar left">
        <Connect />
        <Jog />
        <Overrides />
        <Macros />
      </aside>
      <div className="center">
        <section className="panel readout">
          <div><label>State</label><b className={'st st-' + (status?.state ?? 'Disconnected')}>{status?.state ?? 'Disconnected'}</b></div>
          <div><label>X</label><b>{status?.wpos.x.toFixed(3) ?? '–'}</b></div>
          <div><label>Y</label><b>{status?.wpos.y.toFixed(3) ?? '–'}</b></div>
          <div><label>Machine X/Y</label><b className="dim">{mp ? `${mp.x.toFixed(1)} / ${mp.y.toFixed(1)}` : '–'}</b></div>
          <div><label>Feed</label><b>{status ? Math.round(status.feed / 60) : '–'}<small> mm/s</small></b></div>
          <div><label>Laser S</label><b>{status?.spindle ?? '–'}</b></div>
          <button
            disabled={!status || status.state === 'Disconnected' || !!job}
            onClick={() => {
              const lines = makeFrameLines()
              if (!lines) return notify('error', 'Nothing to frame yet. Add something to the design first.')
              void api('job.start', { lines, name: 'frame', where: 'pc' })
            }}
          >
            ▭ Frame design
          </button>
        </section>
        {alarm && <div className="alarm">⚠ {alarm}</div>}
        {job && (
          <section className="panel">
            <header><h3>Running: {job.name}</h3><small>{job.where === 'device' ? 'on ESP32' : 'from this computer'}</small></header>
            <div className="bar"><i style={{ width: `${(job.acked / Math.max(1, job.total)) * 100}%` }} /></div>
            <LiveView />
            <p className="hint">{Math.round((job.acked / Math.max(1, job.total)) * 100)}% · {fmtTime(job.elapsedMs / 1000)} elapsed{job.etaMs ? ` · about ${fmtTime(job.etaMs / 1000)} left` : ''}</p>
          </section>
        )}
        <ResumeBar />
        <Console />
        {raw && <p className="hint">G-code file "{raw.name}" is loaded. Open Preview to send it.</p>}
      </div>
      <aside className="sidebar">
        <DeviceFiles />
        <GrblSettings />
      </aside>
    </div>
  )
}

function Macros() {
  const { api, notify } = useStore.getState()
  const status = useStore((s) => s.status)
  const job = useStore((s) => s.job)
  const [macros, setMacros] = useState<Macro[]>(loadMacros)
  const [editing, setEditing] = useState<Macro | null>(null)
  const disabled = !status || status.state === 'Disconnected' || !!job
  const persist = (m: Macro[]) => (setMacros(m), saveMacros(m))
  const run = async (m: Macro) => {
    for (const l of macroLines(m.code)) {
      await api('send', { text: l })
      await new Promise((r) => setTimeout(r, 60))
    }
    notify('ok', `Ran "${m.name}".`)
  }
  return (
    <section className="panel">
      <header>
        <h3>Macros</h3>
        <button className="ghost" onClick={() => setEditing({ id: 'm_' + Date.now().toString(36), name: '', code: '' })}>＋ New</button>
      </header>
      <div className="macros">
        {macros.map((m) => (
          <div key={m.id} className="macro">
            <button disabled={disabled} title={m.code} onClick={() => void run(m)}>{m.name}</button>
            <button className="ghost" title="Edit" onClick={() => setEditing(m)}>✎</button>
          </div>
        ))}
      </div>
      {editing && (
        <div className="subpanel">
          <label className="field"><span>Name</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="field"><span>Commands (one per line)</span><textarea rows={4} value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></label>
          <div className="grid2 btns">
            <button
              className="btn primary"
              disabled={!editing.name.trim() || !macroLines(editing.code).length}
              onClick={() => {
                const exists = macros.some((m) => m.id === editing.id)
                persist(exists ? macros.map((m) => (m.id === editing.id ? editing : m)) : [...macros, editing])
                setEditing(null)
              }}
            >
              Save
            </button>
            <button onClick={() => (persist(macros.filter((m) => m.id !== editing.id)), setEditing(null))}>Delete</button>
          </div>
          <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
    </section>
  )
}

function ResumeBar() {
  const r = useStore((s) => s.resumable)
  const job = useStore((s) => s.job)
  const status = useStore((s) => s.status)
  const { api, notify } = useStore.getState()
  const guess = r ? (r.pos ? findResumeLine(r.lines, r.pos, Math.max(0, r.acked - 80), Math.min(r.lines.length - 1, r.acked)) : Math.max(0, r.acked - 20)) : 0
  const [line, setLine] = useState<number | null>(null)
  if (!r || job) return null
  const from = line ?? guess
  const idle = status?.state === 'Idle'
  return (
    <section className="panel resume">
      <header><h3>Resume "{r.name}"</h3><button className="ghost" onClick={() => useStore.setState({ resumable: null })}>Dismiss</button></header>
      <p className="hint">The job stopped at about line {r.acked.toLocaleString()} of {r.lines.length.toLocaleString()}. Don't move the material or change the origin, then continue from the matching point.</p>
      <label className="field small">
        <span>Start from line</span>
        <input type="number" min={1} max={r.lines.length} value={from + 1} onChange={(e) => setLine(Math.max(0, Math.min(r.lines.length - 1, Number(e.target.value) - 1)))} />
      </label>
      <p className="hint">{r.lines[from]}</p>
      <button
        className="btn primary"
        disabled={!idle}
        onClick={async () => {
          const lines = buildResume(r.lines, from)
          useStore.setState({ lastJob: { lines: GrblClient.prepareJob(lines), name: r.name + ' (resumed)' } })
          await api('job.start', { lines, name: r.name + ' (resumed)', where: 'pc' })
          useStore.setState({ resumable: null })
          notify('info', 'Resuming. The head moves to the restart point with the laser off first.')
        }}
      >
        {idle ? 'Resume job' : 'Machine must be Idle (unlock it first)'}
      </button>
    </section>
  )
}
