import { describe, expect, it } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readlinkSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Updater, compareVersions, type UpdateState } from '../src/server/updater'

describe('compareVersions', () => {
  it('orders versions', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.2.1', '0.10.0')).toBe(-1)
  })
})

function fakeRelease(version: string, sha?: string) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'ember-rel-'))
  const pkg = path.join(work, 'ember-box')
  mkdirSync(path.join(pkg, 'dist/server'), { recursive: true })
  writeFileSync(path.join(pkg, 'dist/server/server.js'), 'console.log("hi")\n')
  writeFileSync(path.join(pkg, 'VERSION'), version + '\n')
  const tgz = path.join(work, `ember-box-${version}.tar.gz`)
  execFileSync('tar', ['-czf', tgz, '-C', work, 'ember-box'])
  const data = readFileSync(tgz)
  const hash = sha ?? crypto.createHash('sha256').update(data).digest('hex')
  return { data, sha: `${hash}  ember-box-${version}.tar.gz\n` }
}

async function serve(version: string, badSha = false) {
  const rel = fakeRelease(version, badSha ? 'a'.repeat(64) : undefined)
  const srv = http.createServer((req, res) => {
    const base = `http://localhost:${(srv.address() as { port: number }).port}`
    if (req.url?.startsWith('/repos/o/r/releases')) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify([{ tag_name: 'latest-image', prerelease: true, assets: [] }, { tag_name: 'v' + version, body: 'notes', assets: [{ name: `ember-box-${version}.tar.gz`, browser_download_url: base + '/tar' }, { name: `ember-box-${version}.tar.gz.sha256`, browser_download_url: base + '/sha' }] }]))
    }
    if (req.url === '/tar') return res.end(rel.data)
    if (req.url === '/sha') return res.end(rel.sha)
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, r))
  return { srv, base: `http://localhost:${(srv.address() as { port: number }).port}` }
}

function box(current: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ember-box-'))
  mkdirSync(path.join(root, 'releases', current), { recursive: true })
  require('node:fs').symlinkSync(path.join('releases', current), path.join(root, 'current'))
  return root
}

describe('Updater', () => {
  it('finds, downloads, verifies and switches to a newer version', async () => {
    const { srv, base } = await serve('0.3.0')
    const root = box('0.2.1')
    const events: UpdateState[] = []
    let restarted = false
    let busy = false
    const u = new Updater({ repo: 'o/r', root, dataDir: root, currentVersion: '0.2.1', isBusy: () => busy, emit: (s) => events.push(s), apiBase: base, restart: () => (restarted = true) })
    const st = await u.check()
    expect(st.available).toBe(true)
    expect(st.latest).toBe('0.3.0')
    busy = true
    await expect(u.apply(false)).rejects.toThrow(/busy/)
    busy = false
    await u.apply(false)
    expect(readlinkSync(path.join(root, 'current'))).toBe(path.join('releases', '0.3.0'))
    expect(existsSync(path.join(root, 'releases/0.3.0/dist/server/server.js'))).toBe(true)
    expect(readFileSync(path.join(root, 'pending-update'), 'utf8')).toContain('from=0.2.1')
    await new Promise((r) => setTimeout(r, 1700))
    expect(restarted).toBe(true)
    srv.close()
  })

  it('refuses a download whose checksum is wrong and leaves the old version running', async () => {
    const { srv, base } = await serve('0.3.0', true)
    const root = box('0.2.1')
    const u = new Updater({ repo: 'o/r', root, dataDir: root, currentVersion: '0.2.1', isBusy: () => false, emit: () => undefined, apiBase: base })
    await u.check()
    await expect(u.apply(false)).rejects.toThrow(/damaged/)
    expect(readlinkSync(path.join(root, 'current'))).toBe(path.join('releases', '0.2.1'))
    srv.close()
  })

  it('says nothing is available when already up to date', async () => {
    const { srv, base } = await serve('0.2.1')
    const root = box('0.2.1')
    const u = new Updater({ repo: 'o/r', root, dataDir: root, currentVersion: '0.2.1', isBusy: () => false, emit: () => undefined, apiBase: base })
    expect((await u.check()).available).toBe(false)
    srv.close()
  })
})
