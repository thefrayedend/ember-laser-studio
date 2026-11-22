import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'

export const fmtTime = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) return '–'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

function heat(t: number) {
  // dim red-orange to bright yellow-white, so strong passes stand out
  const r = 255
  const g = Math.round(90 + 150 * t)
  const b = Math.round(40 + 190 * t * t)
  return `rgb(${r},${g},${b})`
}

export function PreviewView() {
  const gen = useStore((s) => s.gen)
  const busy = useStore((s) => s.genBusy)
  const err = useStore((s) => s.genError)
  const machine = useStore((s) => s.machine)
  const origin = useStore((s) => s.origin)
  const raw = useStore((s) => s.raw)
  const doc = useStore((s) => s.doc)
  const { generate, setTab, openSend, api, notify } = useStore.getState()
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [pct, setPct] = useState(100)
  const [travel, setTravel] = useState(false)
  const [size, setSize] = useState({ w: 800, h: 600 })

  useEffect(() => {
    if (!gen && !busy) void generate()
  }, [gen, busy, generate, doc, origin, machine])

  useEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size.w, size.h)
    const pad = 40
    const bounds = gen?.packed.bounds
    // Raw G-code and job-origin output are in work coordinates, so frame the view around the job instead of the bed.
    const workSpace = !!gen && (!gen.fromDesign || origin.mode === 'job')
    let vx = 0
    let vy = 0
    let vw = machine.bedWidth
    let vh = machine.bedHeight
    if (workSpace && bounds) {
      const mx = Math.max(10, (bounds.maxX - bounds.minX) * 0.1)
      vx = bounds.minX - mx
      vw = bounds.maxX - bounds.minX + mx * 2
      vy = bounds.minY - mx
      vh = bounds.maxY - bounds.minY + mx * 2
    }
    const k = Math.min((size.w - pad * 2) / vw, (size.h - pad * 2) / vh)
    const ox = (size.w - vw * k) / 2 - vx * k
    const oy = (size.h + vh * k) / 2 + vy * k // y flipped: machine Y is up
    const X = (x: number) => ox + x * k
    const Y = (y: number) => oy - y * k
    // bed
    if (!workSpace || !raw) {
      ctx.fillStyle = '#1a1d23'
      ctx.strokeStyle = '#3a404b'
      if (!workSpace) {
        ctx.fillRect(X(0), Y(machine.bedHeight), machine.bedWidth * k, machine.bedHeight * k)
        ctx.strokeRect(X(0), Y(machine.bedHeight), machine.bedWidth * k, machine.bedHeight * k)
      }
    }
    // axes at work zero
    ctx.strokeStyle = '#2f3641'
    ctx.beginPath()
    ctx.moveTo(X(vx - 1000), Y(0))
    ctx.lineTo(X(vx + 5000), Y(0))
    ctx.moveTo(X(0), Y(vy - 1000))
    ctx.lineTo(X(0), Y(vy + 5000))
    ctx.stroke()
    if (workSpace) {
      ctx.fillStyle = '#ff6a2b'
      ctx.beginPath()
      ctx.arc(X(0), Y(0), 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '12px system-ui, sans-serif'
      ctx.fillText(raw ? 'Work zero' : 'The laser head starts here', X(0) + 10, Y(0) - 8)
    }
    if (!gen) return
    const p = gen.packed
    const n = Math.floor((p.n * pct) / 100)
    const maxS = Math.max(1, p.maxS)
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(0.6, Math.min(2.2, 0.12 * k))
    const buckets: number[][] = Array.from({ length: 8 }, () => [])
    if (travel) {
      ctx.strokeStyle = 'rgba(80,150,255,0.35)'
      ctx.lineWidth = 0.6
      ctx.beginPath()
      for (let i = 0; i < n; i++)
        if (p.rapid[i]) {
          ctx.moveTo(X(p.xy[i * 4]), Y(p.xy[i * 4 + 1]))
          ctx.lineTo(X(p.xy[i * 4 + 2]), Y(p.xy[i * 4 + 3]))
        }
      ctx.stroke()
      ctx.lineWidth = Math.max(0.6, Math.min(2.2, 0.12 * k))
    }
    for (let i = 0; i < n; i++) if (p.s[i] > 0) buckets[Math.min(7, Math.floor((p.s[i] / maxS) * 8))].push(i)
    buckets.forEach((idx, b) => {
      if (!idx.length) return
      ctx.strokeStyle = heat((b + 0.5) / 8)
      ctx.beginPath()
      for (const i of idx) {
        ctx.moveTo(X(p.xy[i * 4]), Y(p.xy[i * 4 + 1]))
        ctx.lineTo(X(p.xy[i * 4 + 2]), Y(p.xy[i * 4 + 3]))
      }
      ctx.stroke()
    })
    if (n > 0 && n < p.n) {
      const i = n - 1
      ctx.fillStyle = '#3ddc84'
      ctx.beginPath()
      ctx.arc(X(p.xy[i * 4 + 2]), Y(p.xy[i * 4 + 3]), 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [gen, pct, travel, size, machine, origin, raw])

  const r = gen?.result
  const est = r?.estimateSeconds ?? gen?.packed.estimateSeconds ?? 0
  const b = gen?.packed.bounds

  return (
    <div className="preview">
      <div className="stage" ref={wrap}>
        <canvas ref={ref} style={{ width: size.w, height: size.h }} />
        {busy && <div className="drop">Generating toolpath…</div>}
        {err && <div className="drop err">{err}</div>}
        {!busy && gen && gen.packed.n === 0 && <div className="drop">Nothing to burn. Add something to a layer that is switched on (🔥).</div>}
      </div>
      <aside className="sidebar">
        <section className="panel">
          <header><h3>Job</h3><small>{gen?.name}</small></header>
          <dl className="stats">
            <dt>Estimated time</dt><dd>{fmtTime(est)}</dd>
            <dt>Size</dt><dd>{b ? `${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm` : '–'}</dd>
            <dt>G-code lines</dt><dd>{gen?.lines.length.toLocaleString() ?? '–'}</dd>
            <dt>Moves drawn</dt><dd>{gen?.packed.n.toLocaleString() ?? '–'}</dd>
          </dl>
          {gen?.note && <p className="hint" style={{ color: 'var(--text)' }}>{gen.note}</p>}
          {r?.warnings.map((w, i) => (
            <p key={i} className="warn">⚠ {w}</p>
          ))}
          <label className="field">
            <span>Replay {pct}%</span>
            <input type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          </label>
          <label className="check"><input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} />Show travel moves</label>
          <p className="hint">Brighter = more power. Estimates ignore acceleration, so real jobs run a little longer.</p>
        </section>
        <section className="panel actions">
          <button className="primary big" disabled={!gen || gen.packed.n === 0} onClick={() => openSend(true)}>Send to laser…</button>
          <button
            disabled={!gen}
            onClick={async () => {
              const path = await api<string | null>('file.save', { defaultName: `${gen!.name}.nc`, data: gen!.lines.join('\n') + '\n', filters: [{ name: 'G-code', extensions: ['nc', 'gcode'] }] })
              if (path) notify('ok', 'G-code saved.')
            }}
          >
            Export G-code
          </button>
          <button onClick={() => setTab('design')}>← Back to design</button>
        </section>
      </aside>
    </div>
  )
}
