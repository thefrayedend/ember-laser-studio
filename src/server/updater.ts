/**
 * Self-update for the laser box. Looks for a newer GitHub release, and installs it only when asked (or, if the
 * owner turned it on, when the laser is idle). Layout on the box:
 *   /opt/ember/releases/<version>/   each installed version
 *   /opt/ember/current  ->  releases/<version>      (the one that runs)
 *   /opt/ember/pending-update        written during an update; removed once the new version has run 30 s
 * If the new version cannot start, the service's ExecStartPre script (ember-rollback) switches `current` back.
 */
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export interface UpdateState {
  type: 'update'
  enabled: boolean
  current: string
  latest: string | null
  available: boolean
  notes: string
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'error'
  message: string
  auto: boolean
  checkedAt: number | null
}

export const compareVersions = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  return 0
}

export interface UpdaterOpts {
  /** owner/name on GitHub; empty disables updates */
  repo: string
  /** /opt/ember on the box; empty disables updates (desktop or development use) */
  root: string
  dataDir: string
  currentVersion: string
  isBusy: () => boolean
  emit: (s: UpdateState) => void
  /** where to fetch from (tests point this at a fake GitHub) */
  apiBase?: string
  restart?: () => void
}

export class Updater {
  private st: UpdateState
  private timer?: ReturnType<typeof setInterval>
  private working = false
  private autoFile: string
  private latestAssets: { tar: string; sha: string; version: string } | null = null

  constructor(private o: UpdaterOpts) {
    this.autoFile = path.join(o.dataDir, 'update.json')
    let auto = false
    try {
      auto = !!JSON.parse(readFileSync(this.autoFile, 'utf8')).auto
    } catch {
      /* default off */
    }
    this.st = { type: 'update', enabled: !!(o.repo && o.root), current: o.currentVersion, latest: null, available: false, notes: '', phase: 'idle', message: '', auto, checkedAt: null }
  }

  get state() {
    return this.st
  }
  private set(p: Partial<UpdateState>) {
    this.st = { ...this.st, ...p }
    this.o.emit(this.st)
  }

  start() {
    if (!this.st.enabled) return
    this.healthWatch()
    setTimeout(() => void this.check(), 2 * 60 * 1000)
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000)
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  setAuto(on: boolean) {
    writeFileSync(this.autoFile, JSON.stringify({ auto: on }))
    this.set({ auto: on })
    if (on && this.st.available) void this.apply(true)
    return this.st
  }

  /** The new version counts as good once it has run for 30 seconds: then the rollback marker goes away. */
  private healthWatch() {
    const marker = path.join(this.o.root, 'pending-update')
    if (!existsSync(marker)) return
    setTimeout(() => {
      void fs.rm(marker, { force: true })
      void this.cleanOld()
    }, 30000)
  }
  private async cleanOld() {
    try {
      const dir = path.join(this.o.root, 'releases')
      const cur = path.basename(await fs.realpath(path.join(this.o.root, 'current')))
      const all = (await fs.readdir(dir)).filter((n) => !n.endsWith('.partial'))
      const keep = new Set([cur, ...all.filter((n) => n !== cur).sort(compareVersions).slice(-1)])
      for (const n of all) if (!keep.has(n)) await fs.rm(path.join(dir, n), { recursive: true, force: true })
    } catch {
      /* tidying is optional */
    }
  }

  async check(): Promise<UpdateState> {
    if (!this.st.enabled || this.working) return this.st
    this.set({ phase: 'checking', message: '' })
    try {
      const base = this.o.apiBase ?? 'https://api.github.com'
      // The newest release whose tag is a plain version number (the repo also has an "image" release that must be ignored).
      const r = await fetch(`${base}/repos/${this.o.repo}/releases?per_page=30`, { headers: { 'User-Agent': 'ember-laser-box', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) })
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
      type Rel = { tag_name: string; body?: string; draft?: boolean; prerelease?: boolean; assets: { name: string; browser_download_url: string }[] }
      const rels = ((await r.json()) as Rel[]).filter((x) => /^v\d+\.\d+\.\d+$/.test(x.tag_name) && !x.draft && !x.prerelease)
      rels.sort((a, b) => compareVersions(b.tag_name, a.tag_name))
      const j = rels[0]
      if (!j) throw new Error('No release found')
      const version = j.tag_name.replace(/^v/, '')
      const tar = j.assets.find((a) => a.name === `ember-box-${version}.tar.gz`)
      const sha = j.assets.find((a) => a.name === `ember-box-${version}.tar.gz.sha256`)
      const newer = compareVersions(version, this.o.currentVersion) > 0
      this.latestAssets = tar && sha ? { tar: tar.browser_download_url, sha: sha.browser_download_url, version } : null
      this.set({ latest: version, available: newer && !!this.latestAssets, notes: (j.body ?? '').slice(0, 2000), phase: 'idle', checkedAt: Date.now(), message: newer && !this.latestAssets ? 'A newer version exists but its package is not attached yet.' : '' })
      if (this.st.available && this.st.auto && !this.o.isBusy()) void this.apply(true)
    } catch (e) {
      this.set({ phase: 'error', message: `Could not check for updates: ${(e as Error).message}`, checkedAt: Date.now() })
    }
    return this.st
  }

  async apply(automatic = false): Promise<UpdateState> {
    const a = this.latestAssets
    if (!this.st.enabled) throw new Error('Updates are not set up on this machine.')
    if (!a || !this.st.available) throw new Error('There is no update to install.')
    if (this.working) throw new Error('An update is already in progress.')
    if (this.o.isBusy()) {
      if (automatic) return this.st
      throw new Error('The laser is busy. Install the update when the job has finished.')
    }
    this.working = true
    const root = this.o.root
    const part = path.join(root, 'releases', `${a.version}.partial`)
    const final = path.join(root, 'releases', a.version)
    try {
      this.set({ phase: 'downloading', message: `Downloading ${a.version}…` })
      await fs.mkdir(path.join(root, 'releases'), { recursive: true })
      await fs.rm(part, { recursive: true, force: true })
      const get = async (u: string) => {
        const r = await fetch(u, { headers: { 'User-Agent': 'ember-laser-box' }, signal: AbortSignal.timeout(10 * 60 * 1000) })
        if (!r.ok) throw new Error(`download failed (${r.status})`)
        return Buffer.from(await r.arrayBuffer())
      }
      const [tarball, shaText] = await Promise.all([get(a.tar), get(a.sha)])
      const want = /[0-9a-f]{64}/i.exec(shaText.toString('utf8'))?.[0]?.toLowerCase()
      const got = crypto.createHash('sha256').update(tarball).digest('hex')
      if (!want || want !== got) throw new Error('The download is damaged (checksum does not match). Nothing was changed.')

      this.set({ phase: 'installing', message: 'Installing…' })
      await fs.mkdir(part, { recursive: true })
      const tf = path.join(root, `update-${a.version}.tar.gz`)
      await fs.writeFile(tf, tarball)
      await new Promise<void>((res, rej) => {
        const p = spawn('tar', ['-xzf', tf, '-C', part, '--strip-components=1'], { stdio: 'ignore' })
        p.on('close', (c) => (c === 0 ? res() : rej(new Error('Could not unpack the update.'))))
        p.on('error', rej)
      })
      await fs.rm(tf, { force: true })
      const entry = path.join(part, 'dist', 'server', 'server.js')
      if (!existsSync(entry)) throw new Error('The update package is missing the program.')
      await new Promise<void>((res, rej) => {
        const p = spawn(process.execPath, ['--check', entry], { stdio: 'ignore' })
        p.on('close', (c) => (c === 0 ? res() : rej(new Error('The new program has an error. Nothing was changed.'))))
      })
      await fs.rm(final, { recursive: true, force: true })
      await fs.rename(part, final)

      // Switch over in one step, and leave a marker so a version that cannot start gets rolled back.
      const from = existsSync(path.join(root, 'current')) ? path.basename(await fs.realpath(path.join(root, 'current'))) : this.o.currentVersion
      await fs.writeFile(path.join(root, 'pending-update'), `from=${from}\nto=${a.version}\nattempts=0\n`)
      const tmpLink = path.join(root, 'current.new')
      await fs.rm(tmpLink, { force: true })
      await fs.symlink(path.join('releases', a.version), tmpLink)
      await fs.rename(tmpLink, path.join(root, 'current'))

      this.set({ phase: 'restarting', message: `Version ${a.version} is installed. Restarting…` })
      setTimeout(() => (this.o.restart ?? (() => process.exit(0)))(), 1500) // systemd starts it again
    } catch (e) {
      await fs.rm(part, { recursive: true, force: true }).catch(() => undefined)
      this.working = false
      this.set({ phase: 'error', message: (e as Error).message })
      throw e
    }
    return this.st
  }
}
