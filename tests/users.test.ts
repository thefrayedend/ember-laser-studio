import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserStore, allowed, capPower } from '../src/server/users'

const fresh = () => new UserStore(path.join(mkdtempSync(path.join(tmpdir(), 'ember-u-')), 'users.json'))

describe('UserStore', () => {
  it('creates users, logs in, and rejects wrong passwords', () => {
    const s = fresh()
    expect(s.empty).toBe(true)
    s.create('Owner', 'secret1', 'admin')
    s.create('Sam', 'pass1234', 'user')
    const sid = s.login('owner', 'secret1', '1.1.1.1')
    expect(s.who(sid)).toEqual({ name: 'Owner', role: 'admin' })
    expect(() => s.login('Owner', 'nope', '1.1.1.1')).toThrow(/Wrong/)
    expect(() => s.create('Sam', 'x1234', 'user')).toThrow(/taken/)
  })
  it('slows guessing after five misses', () => {
    const s = fresh()
    s.create('Owner', 'secret1', 'admin')
    for (let i = 0; i < 5; i++) expect(() => s.login('Owner', 'bad', '9.9.9.9')).toThrow()
    expect(() => s.login('Owner', 'secret1', '9.9.9.9')).toThrow(/Too many/)
    expect(s.who(s.login('Owner', 'secret1', '8.8.8.8'))?.name).toBe('Owner')
  })
  it('keeps one admin, ends sessions when a user is switched off, and persists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ember-u-'))
    const f = path.join(dir, 'users.json')
    const s = new UserStore(f)
    s.create('Owner', 'secret1', 'admin')
    s.create('Sam', 'pass1234', 'user')
    expect(() => s.update('Owner', { role: 'user' })).toThrow(/at least one/)
    expect(() => s.remove('Owner')).toThrow(/at least one/)
    const sid = s.login('Sam', 'pass1234', 'x')
    s.update('Sam', { disabled: true })
    expect(s.who(sid)).toBeUndefined()
    expect(() => s.login('Sam', 'pass1234', 'x')).toThrow(/switched off/)
    s.setSettings({ powerCap: 60 })
    const again = new UserStore(f)
    expect(again.settings.powerCap).toBe(60)
    expect(again.list().length).toBe(2)
    expect(() => s.setSettings({ powerCap: 0 })).toThrow()
  })
  it('owner reset sets a new admin password', () => {
    const s = fresh()
    s.create('Owner', 'secret1', 'admin')
    s.resetOwner('Owner', 'newpass')
    expect(() => s.login('Owner', 'secret1', 'a')).toThrow()
    expect(s.who(s.login('Owner', 'newpass', 'a'))?.role).toBe('admin')
  })
})

describe('roles and power cap', () => {
  it('viewers can only watch and stop; users cannot touch admin things', () => {
    expect(allowed('viewer', 'job.start')).toBe(false)
    expect(allowed('viewer', 'estop')).toBe(true)
    expect(allowed('user', 'job.start')).toBe(true)
    expect(allowed('user', 'admin.users.create')).toBe(false)
    expect(allowed('user', 'update.apply')).toBe(false)
    expect(allowed('admin', 'update.apply')).toBe(true)
  })
  it('lowers S values above the cap and leaves other lines alone', () => {
    const r = capPower(['G1 X1 Y1 S800 F1000', 'S900', 'M4 S1000', 'G1 X2 S300', '(comment S999)', 'G0 X5'], 50, 1000)
    expect(r.lines).toEqual(['G1 X1 Y1 S500 F1000', 'S500', 'M4 S500', 'G1 X2 S300', '(comment S999)', 'G0 X5'])
    expect(r.lowered).toBe(3)
  })
  it('a bare S line, lower case, and S before the move are capped; comments and $ lines are not', () => {
    expect(capPower(['S900', 's700', 'S900 G1 X1', 'G1 X1 ; S900', '$30=1000'], 50, 1000).lines).toEqual(['S500', 's500'.replace('s', 'S'), 'S500 G1 X1', 'G1 X1 ; S900', '$30=1000'])
  })
})
