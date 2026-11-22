import { useEffect, useState } from 'react'
import { useStore } from './store'
import { useEscape } from './lib/useEscape'

interface U { name: string; role: 'admin' | 'user' | 'viewer'; disabled: boolean }
const ROLE_TEXT = { admin: 'Admin: everything', user: 'User: design and run jobs', viewer: 'Viewer: watch only' }

export function AdminDialog() {
  const open = useStore((s) => s.adminOpen)
  if (!open) return null
  return <Inner />
}

function Inner() {
  const close = () => useStore.getState().setAdminOpen(false)
  useEscape(close)
  const api = useStore.getState().api
  const me = useStore((s) => s.me)
  const cap = useStore((s) => s.powerCap)
  const [tab, setTab] = useState<'users' | 'settings'>('users')
  const [users, setUsers] = useState<U[]>([])
  const [err, setErr] = useState('')
  const [nn, setNn] = useState('')
  const [np, setNp] = useState('')
  const [nr, setNr] = useState<U['role']>('user')
  const [capText, setCapText] = useState(String(cap))
  const run = async (f: () => Promise<unknown>) => {
    try {
      setErr('')
      const r = await f()
      if (Array.isArray(r)) setUsers(r as U[])
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const reload = () => run(() => window.ember.invoke('admin.users.list'))
  useEffect(() => void reload(), [])
  const up = (name: string, ch: object) => run(() => window.ember.invoke('admin.users.update', { name, ...ch }))
  const resetPw = (name: string) => {
    const p = window.prompt(`New password for ${name}:`)
    if (p) void up(name, { password: p })
  }
  const del = (name: string) => window.confirm(`Delete ${name}? They will be signed out.`) && run(() => window.ember.invoke('admin.users.remove', { name }))
  const saveCap = () =>
    run(async () => {
      const r = (await window.ember.invoke('admin.settings.set', { powerCap: Number(capText) })) as { powerCap: number }
      useStore.setState({ powerCap: r.powerCap })
      useStore.getState().notify('ok', `Power cap is now ${r.powerCap}%.`)
    })

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Admin</h2>
        <div className="seg">
          <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>People</button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
        </div>
        {err && <p className="err">{err}</p>}
        {tab === 'users' && (
          <>
            <p className="hint">Everyone signs in at the box's address with their own name and password. Only admins see this page.</p>
            <div style={{ display: 'grid', gap: 6 }}>
              {users.map((u) => (
                <div key={u.name} style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: u.disabled ? 0.5 : 1 }}>
                  <b style={{ flex: 1 }}>{u.name}{u.name === me?.name ? ' (you)' : ''}</b>
                  <select value={u.role} onChange={(e) => void up(u.name, { role: e.target.value })}>
                    {(Object.keys(ROLE_TEXT) as U['role'][]).map((r) => <option key={r} value={r}>{ROLE_TEXT[r]}</option>)}
                  </select>
                  <button onClick={() => void up(u.name, { disabled: !u.disabled })}>{u.disabled ? 'Switch on' : 'Switch off'}</button>
                  <button onClick={() => resetPw(u.name)}>Password</button>
                  <button onClick={() => void del(u.name)}>Delete</button>
                </div>
              ))}
            </div>
            <h4>Add a person</h4>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="Name" value={nn} onChange={(e) => setNn(e.target.value)} />
              <input placeholder="Password" value={np} onChange={(e) => setNp(e.target.value)} />
              <select value={nr} onChange={(e) => setNr(e.target.value as U['role'])}>
                {(Object.keys(ROLE_TEXT) as U['role'][]).map((r) => <option key={r} value={r}>{ROLE_TEXT[r]}</option>)}
              </select>
              <button className="primary" onClick={() => void run(async () => { const r = await window.ember.invoke('admin.users.create', { name: nn, password: np, role: nr }); setNn(''); setNp(''); return r })}>Add</button>
            </div>
          </>
        )}
        {tab === 'settings' && (
          <>
            <label className="field">
              <span>Power cap (%): the most laser power any job from this box can use</span>
              <input value={capText} onChange={(e) => setCapText(e.target.value)} />
            </label>
            <p className="hint">100 means no cap. A lower cap quietly lowers any higher power in a job. Good for a shared laser or a fresh start. It also applies to the test dot and live power adjust.</p>
            <div className="modal-actions"><button className="primary" onClick={() => void saveCap()}>Save</button></div>
          </>
        )}
        <div className="modal-actions"><button onClick={() => (close(), useStore.getState().setHelpOpen('admin'))}>Help</button><button onClick={close}>Close</button></div>
      </div>
    </div>
  )
}
