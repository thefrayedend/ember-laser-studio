import { useEscape } from './lib/useEscape'
import { useState } from 'react'
import { useStore } from './store'
import { GrblClient } from '../core/grbl/client'
import { fmtTime } from './PreviewView'
import { SlideToStart } from './SlideToStart'
import { sanityNotes } from '../core/sanity'
import type { Anchor } from '../core/types'

const ANCHORS: { id: Anchor; label: string }[] = [
  { id: 'tl', label: '↖' },
  { id: 'tr', label: '↗' },
  { id: 'center', label: '●' },
  { id: 'bl', label: '↙' },
  { id: 'br', label: '↘' },
]

export function SendDialog() {
  const open = useStore((s) => s.sendOpen)
  const gen = useStore((s) => s.gen)
  const origin = useStore((s) => s.origin)
  const conn = useStore((s) => s.conn)
  const status = useStore((s) => s.status)
  const settings = useStore((s) => s.settings)
  const raw = useStore((s) => s.raw)
  const machine = useStore((s) => s.machine)
  const homed = useStore((s) => s.homed)
  const doc = useStore((s) => s.doc)
  const powerCap = useStore((s) => s.powerCap)
  const { openSend, setOrigin, api, setTab, notify } = useStore.getState()
  const [where, setWhere] = useState<'pc' | 'device'>('pc')
  const [busy, setBusy] = useState(false)
  useEscape(() => openSend(false))
  if (!open || !gen) return null

  const state = status?.state ?? 'Disconnected'
  const checks: { ok: boolean | null; text: string }[] = [
    { ok: conn.connected, text: conn.connected ? `Connected to ${conn.label}` : 'Not connected. Go to the Device tab and connect.' },
    { ok: state === 'Idle', text: state === 'Idle' ? 'Machine is idle' : `Machine is ${state}. It must be Idle${state === 'Alarm' ? ' (unlock or home it on the Device tab)' : ''}.` },
    settings[32] === undefined
      ? { ok: null, text: 'Laser mode ($32) not read yet' }
      : { ok: settings[32] === '1', text: settings[32] === '1' ? 'Laser mode is on ($32=1)' : 'Laser mode is OFF ($32=0). The laser would stay on during moves. Set $32=1 on the Device tab.' },
    // $30 is the S value GRBL treats as 100%. If it differs from the profile, every power in the job is wrong.
    settings[30] === undefined || raw
      ? { ok: null, text: raw ? 'Imported G-code uses its own power values' : 'Max power ($30) not read yet' }
      : Number(settings[30]) === machine.maxS
        ? { ok: true, text: `Power scale matches the machine ($30=${settings[30]})` }
        : { ok: false, text: `The machine's full power is S${settings[30]} ($30) but this profile uses S${machine.maxS}. Every power would be wrong. Use the button below to fix the profile.` },
    ...(gen.result?.warnings ?? []).map((w) => ({ ok: false as boolean | null, text: w })),
  ]
  const s30bad = !raw && settings[30] !== undefined && Number(settings[30]) !== machine.maxS && Number(settings[30]) > 0
  const blocked = checks.slice(0, 4).some((c) => c.ok === false) || (gen.result?.warnings ?? []).some((w) => /larger than|outside/.test(w))
  const jobMode = origin.mode === 'job'
  const used = new Set(doc.objects.map((o) => o.layerId))
  const m3raw = !!raw && raw.lines.some((l) => /^[^;(]*M0*3(?!\d)/i.test(l))
  const notes = raw
    ? m3raw ? [{ level: 'info' as const, text: 'This file uses M3 (constant power). If the connection drops mid-job, the laser can stay on where the head stops. Stay at the machine.' }] : []
    : sanityNotes(doc.layers.filter((l) => l.output && used.has(l.id)), { powerCap, estimateSeconds: gen.result?.estimateSeconds ?? gen.packed.estimateSeconds })

  const start = async () => {
    setBusy(true)
    const prelude = raw ? (raw.jobOrigin ? ['G10 L20 P1 X0 Y0', 'G54'] : []) : jobMode ? ['G10 L20 P1 X0 Y0', 'G54'] : ['G10 L2 P1 X0 Y0', 'G54']
    const all = [...prelude, ...gen.lines]
    useStore.setState({ resumable: null, lastJob: where === 'pc' ? { lines: GrblClient.prepareJob(all), name: gen.name } : null })
    await api('job.start', { lines: all, name: gen.name, where })
    setBusy(false)
    openSend(false)
    setTab('device')
    notify('info', where === 'device' ? 'Job sent to the ESP32. You can close the app; it keeps running.' : 'Job started.')
  }

  return (
    <div className="modal-back" onClick={() => openSend(false)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Send to laser</h2>
        <p className="sub">{gen.name} · about {fmtTime(gen.result?.estimateSeconds ?? gen.packed.estimateSeconds)} · {gen.lines.length.toLocaleString()} lines</p>

        {!raw && (
          <div className="block">
            <h4>Where does the design go?</h4>
            <div className="seg">
              <button className={jobMode ? 'on' : ''} onClick={() => setOrigin({ mode: 'job', anchor: jobMode ? origin.anchor : 'tl' })}>Where the laser head is</button>
              <button className={!jobMode ? 'on' : ''} onClick={() => setOrigin({ mode: 'bed' })}>Same spot as on the bed</button>
            </div>
            {jobMode ? (
              <>
                <p className="hint">Move the head where you want the design (Device tab), then pick which corner of the design sits under the head.</p>
                <div className="anchors">
                  {ANCHORS.map((a) => (
                    <button key={a.id} className={origin.mode === 'job' && origin.anchor === a.id ? 'on' : ''} onClick={() => setOrigin({ mode: 'job', anchor: a.id })}>{a.label}</button>
                  ))}
                </div>
              </>
            ) : (
              <p className={homed ? 'hint' : 'warn'}>{homed ? 'The machine is homed, so position on screen = position on the material.' : 'Press Home on the Device tab first. Until the machine has homed, it does not know where the bed is, and the design can land in the wrong place.'}</p>
            )}
          </div>
        )}
        {raw && <p className="hint">Raw G-code runs exactly as written, in whatever coordinates the file uses.</p>}

        {conn.deviceJobs && (
          <div className="block">
            <h4>Run it from</h4>
            <div className="seg">
              <button className={where === 'pc' ? 'on' : ''} onClick={() => setWhere('pc')}>This computer</button>
              <button className={where === 'device' ? 'on' : ''} onClick={() => setWhere('device')}>ESP32 (walk away safe)</button>
            </div>
            <p className="hint">{where === 'device' ? 'The whole file is uploaded first, then the ESP32 streams it itself. Wi-Fi drops or a sleeping laptop will not interrupt the burn.' : 'The app streams line by line. Keep the computer awake and connected.'}</p>
          </div>
        )}

        {s30bad && (
          <button onClick={() => (useStore.getState().setMachine({ ...machine, maxS: Number(settings[30]) }), void useStore.getState().generate())}>Use the machine's full power value (S{settings[30]})</button>
        )}
        <ul className="checks">
          {checks.map((c, i) => (
            <li key={i} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'meh'}>{c.ok === true ? '✓' : c.ok === false ? '✕' : '•'} {c.text}</li>
          ))}
        </ul>

        {notes.length > 0 && (
          <ul className="checks">
            {notes.map((n, i) => <li key={i} className={n.level === 'warn' ? 'bad' : 'meh'}>{n.level === 'warn' ? '⚠' : '•'} {n.text}</li>)}
          </ul>
        )}
        <div className="modal-actions" style={{ alignItems: 'center', gap: 12 }}>
          <button onClick={() => openSend(false)}>Cancel</button>
          <SlideToStart label={busy ? 'Starting…' : blocked ? 'Fix the items above first' : 'Slide to start the laser'} disabled={blocked || busy} onDone={() => void start()} />
        </div>
      </div>
    </div>
  )
}
