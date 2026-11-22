import crypto from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Role = 'admin' | 'user' | 'viewer'
export interface User {
  name: string
  role: Role
  salt: string
  hash: string
  disabled?: boolean
  created: number
}
export interface AdminSettings {
  /** highest laser power (percent of the machine maximum) any job from the box may use */
  powerCap: number
}

export const ROLES: Role[] = ['admin', 'user', 'viewer']
const DEFAULTS: AdminSettings = { powerCap: 100 }
const SESSION_MS = 30 * 24 * 3600 * 1000

const scrypt = (pw: string, salt: string) => crypto.scryptSync(pw, salt, 32).toString('hex')

export const validName = (n: string) => /^[A-Za-z0-9 _.-]{2,24}$/.test(n.trim())
export const validPassword = (p: string) => typeof p === 'string' && p.length >= 4 && p.length <= 200

/** Accounts, sessions and the few settings only the owner should change. Stored as one small JSON file. */
export class UserStore {
  private users: User[] = []
  private sessions = new Map<string, { name: string; at: number }>()
  settings: AdminSettings = { ...DEFAULTS }
  private fails = new Map<string, { n: number; until: number }>()

  constructor(private file: string, private now: () => number = Date.now) {
    if (existsSync(file)) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'))
        this.users = d.users ?? []
        this.settings = { ...DEFAULTS, ...(d.settings ?? {}) }
        for (const [k, v] of Object.entries(d.sessions ?? {})) this.sessions.set(k, v as { name: string; at: number })
      } catch {
        /* start empty */
      }
    }
  }
  private save() {
    writeFileSync(this.file, JSON.stringify({ users: this.users, settings: this.settings, sessions: Object.fromEntries(this.sessions) }, null, 1), { mode: 0o600 })
  }

  get empty() {
    return this.users.length === 0
  }
  list() {
    return this.users.map((u) => ({ name: u.name, role: u.role, disabled: !!u.disabled, created: u.created }))
  }
  private find(name: string) {
    return this.users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase())
  }
  private admins() {
    return this.users.filter((u) => u.role === 'admin' && !u.disabled)
  }

  create(name: string, password: string, role: Role) {
    if (!validName(name)) throw new Error('Names are 2–24 letters, numbers, spaces, dots, dashes or underscores.')
    if (!validPassword(password)) throw new Error('Passwords need at least 4 characters.')
    if (!ROLES.includes(role)) throw new Error('Unknown role.')
    if (this.find(name)) throw new Error('That name is already taken.')
    const salt = crypto.randomBytes(12).toString('hex')
    this.users.push({ name: name.trim(), role, salt, hash: scrypt(password, salt), created: this.now() })
    this.save()
  }
  update(name: string, ch: { password?: string; role?: Role; disabled?: boolean }) {
    const u = this.find(name)
    if (!u) throw new Error('No such user.')
    const wasAdmin = u.role === 'admin' && !u.disabled
    const role = ch.role ?? u.role
    const disabled = ch.disabled ?? !!u.disabled
    if (!ROLES.includes(role)) throw new Error('Unknown role.')
    if (wasAdmin && (role !== 'admin' || disabled) && this.admins().length < 2) throw new Error('Keep at least one active admin.')
    if (ch.password !== undefined) {
      if (!validPassword(ch.password)) throw new Error('Passwords need at least 4 characters.')
      u.salt = crypto.randomBytes(12).toString('hex')
      u.hash = scrypt(ch.password, u.salt)
      this.dropSessions(u.name)
    }
    u.role = role
    u.disabled = disabled
    if (disabled) this.dropSessions(u.name)
    this.save()
  }
  remove(name: string) {
    const u = this.find(name)
    if (!u) return
    if (u.role === 'admin' && !u.disabled && this.admins().length < 2) throw new Error('Keep at least one active admin.')
    this.users = this.users.filter((x) => x !== u)
    this.dropSessions(u.name)
    this.save()
  }
  /** Owner recovery: sets the password of an admin, creating it if it does not exist. */
  resetOwner(name: string, password: string) {
    const u = this.find(name)
    if (!u) return this.create(name, password, 'admin')
    this.update(u.name, { password, role: 'admin', disabled: false })
  }

  /** @returns a session id, or throws a friendly error. `ip` slows down guessing. */
  login(name: string, password: string, ip: string): string {
    const f = this.fails.get(ip)
    if (f && f.until > this.now()) throw new Error('Too many tries. Wait a minute and try again.')
    const u = this.find(name ?? '')
    const ok = !!u && !u.disabled && crypto.timingSafeEqual(Buffer.from(scrypt(String(password ?? ''), u.salt)), Buffer.from(u.hash))
    if (!ok) {
      const n = (f?.n ?? 0) + 1
      this.fails.set(ip, { n, until: n >= 5 ? this.now() + 60_000 : 0 })
      throw new Error(u?.disabled ? 'This account is switched off.' : 'Wrong name or password.')
    }
    this.fails.delete(ip)
    return this.openSession(u!.name)
  }
  openSession(name: string) {
    const id = crypto.randomBytes(24).toString('base64url')
    this.sessions.set(id, { name, at: this.now() })
    this.save()
    return id
  }
  logout(id: string) {
    if (this.sessions.delete(id)) this.save()
  }
  private dropSessions(name: string) {
    for (const [k, v] of this.sessions) if (v.name === name) this.sessions.delete(k)
  }
  /** The signed-in user for a session id (undefined if the session is unknown, expired, or the account is off). */
  who(id: string): { name: string; role: Role } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (this.now() - s.at > SESSION_MS) return void this.sessions.delete(id)
    const u = this.find(s.name)
    return u && !u.disabled ? { name: u.name, role: u.role } : undefined
  }

  setSettings(s: Partial<AdminSettings>) {
    if (s.powerCap !== undefined) {
      const v = Number(s.powerCap)
      if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error('Power cap is a percentage from 1 to 100.')
      this.settings.powerCap = Math.round(v)
    }
    this.save()
  }
}

// ---- what each role may do over the socket ----
const VIEWER_OK = new Set(['ports.list', 'settings.request', 'presets.load', 'app.version', 'update.check', 'esp32.discover', 'device.files', 'job.pause', 'job.stop', 'estop', 'me', 'admin.settings.get'])
const ADMIN_ONLY = new Set(['update.apply', 'update.auto', 'settings.write', 'admin.users.list', 'admin.users.create', 'admin.users.update', 'admin.users.remove', 'admin.settings.set'])

export function allowed(role: Role, name: string): boolean {
  if (role === 'admin') return true
  if (role === 'viewer') return VIEWER_OK.has(name)
  return !ADMIN_ONLY.has(name)
}

/** Clamp every laser-power word (S…) in G-code lines to cap% of `sMax`. Comments and $ settings are left alone. */
export function capPower(lines: string[], capPct: number, sMax: number): { lines: string[]; lowered: number } {
  if (capPct >= 100) return { lines, lowered: 0 }
  const limit = Math.floor((capPct / 100) * sMax)
  let lowered = 0
  const out = lines.map((l) => {
    if (/^\s*\$/.test(l)) return l
    const semi = l.indexOf(';')
    const code = semi < 0 ? l : l.slice(0, semi)
    const tail = semi < 0 ? '' : l.slice(semi)
    // keep (parenthesised comments) untouched
    const fixed = code
      .split(/(\([^)]*\))/)
      .map((part) => (part.startsWith('(') ? part : part.replace(/S(\d+(?:\.\d+)?)/gi, (m, v) => (Number(v) > limit ? (lowered++, `S${limit}`) : m))))
      .join('')
    return fixed + tail
  })
  return { lines: out, lowered }
}
