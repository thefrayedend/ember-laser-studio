/**
 * Ember headless server: runs next to the laser (e.g. on an Orange Pi), owns the USB connection and the camera,
 * and serves the same UI to any browser on the network.
 *
 *   node dist/server/server.js           (PORT=8080, EMBER_DATA=~/.ember, EMBER_CAMERA=/dev/video0)
 */
import http from 'node:http'
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocketServer, type WebSocket } from 'ws'
import { MachineController, type EmberEvent } from '../main/controller'
import { coreHandlers } from '../main/handlers'
import { Updater } from './updater'
import { UserStore, allowed, capPower, type Role } from './users'

const PORT = Number(process.env.PORT ?? 8080)
const DATA = process.env.EMBER_DATA ?? path.join(os.homedir(), '.ember')
const CAMERA = process.env.EMBER_CAMERA ?? '/dev/video0'
const ROOT = process.env.EMBER_WEB ?? path.join(__dirname, '../renderer')
mkdirSync(DATA, { recursive: true })

// ---- access token: whoever has the link can run the laser, so it is random and stays on this machine ----
const tokenFile = path.join(DATA, 'token')
let TOKEN = process.env.EMBER_TOKEN ?? ''
if (!TOKEN) {
  if (existsSync(tokenFile)) TOKEN = readFileSync(tokenFile, 'utf8').trim()
  else {
    TOKEN = crypto.randomBytes(18).toString('base64url')
    writeFileSync(tokenFile, TOKEN, { mode: 0o600 })
  }
}
const COOKIE = 'ember_auth' // proves you hold the private link (owner): lets you create or reset the admin account
const SID = 'ember_sid' // a signed-in session
const sameToken = (a: string) => a.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(TOKEN))
const cookie = (req: http.IncomingMessage, name: string) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')
  return m ? decodeURIComponent(m[1]) : ''
}
const ownerProof = (req: http.IncomingMessage) => sameToken(cookie(req, COOKIE))
const users = new UserStore(path.join(DATA, 'users.json'))
const userOf = (req: http.IncomingMessage) => users.who(cookie(req, SID))
const ipOf = (req: http.IncomingMessage) => req.socket.remoteAddress ?? '?'
const setSid = (id: string) => `${SID}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`

// ---- machine ----
const clients = new Set<WebSocket>()
const last = new Map<string, EmberEvent>()
const REPLAY = new Set(['connection', 'status', 'settings', 'job', 'welcome', 'update'])
const emit = (e: { type: string }) => {
  if (REPLAY.has(e.type)) last.set(e.type, e as EmberEvent)
  const msg = JSON.stringify({ event: e })
  for (const c of clients) if (c.readyState === 1) c.send(msg)
}
const controller = new MachineController(emit)
const versionOf = () => {
  try {
    return readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim()
  } catch {
    return '0.0.0'
  }
}
const updater = new Updater({
  repo: process.env.EMBER_REPO ?? '',
  root: process.env.EMBER_ROOT ?? '',
  dataDir: DATA,
  currentVersion: versionOf(),
  isBusy: () => controller.busy,
  emit,
})
const presetFile = path.join(DATA, 'presets.json')
const core = coreHandlers(controller)
const sMax = () => Number((last.get('settings') as { settings?: Record<number, string> } | undefined)?.settings?.[30]) || 1000
const cap = () => users.settings.powerCap
const handlers: Record<string, (a: any) => unknown> = {
  ...core,
  // The owner's power cap applies to everything that can fire the laser from this box.
  'job.start': (a: { lines: string[]; name: string; where: 'pc' | 'device' }) => core['job.start']({ ...a, lines: capPower(a.lines, cap(), sMax()).lines }),
  send: (a: { text: string }) => core.send({ text: capPower([a.text], cap(), sMax()).lines[0] }),
  pulse: (a: { pct: number; maxS: number }) => core.pulse({ ...a, pct: Math.min(a.pct, cap()) }),
  override: (a: { kind: 'feed' | 'spindle' | 'rapid'; pct: number }) => core.override({ ...a, pct: a.kind === 'spindle' && cap() < 100 ? Math.min(a.pct, 100) : a.pct }),
  'admin.settings.get': () => users.settings,
  'admin.settings.set': (a: { powerCap?: number }) => (users.setSettings(a), users.settings),
  'admin.users.list': () => users.list(),
  'admin.users.create': (a: { name: string; password: string; role: Role }) => (users.create(a.name, a.password, a.role), users.list()),
  'admin.users.update': (a: { name: string; password?: string; role?: Role; disabled?: boolean }) => (users.update(a.name, a), users.list()),
  'admin.users.remove': (a: { name: string }) => (users.remove(a.name), users.list()),
  'presets.load': async () => {
    try {
      return JSON.parse(await fs.readFile(presetFile, 'utf8'))
    } catch {
      return []
    }
  },
  'presets.save': async (a: unknown) => {
    await fs.writeFile(presetFile, JSON.stringify(a, null, 1), 'utf8')
  },
  'app.version': () => versionOf(),
  'update.check': () => updater.check(),
  'update.apply': () => updater.apply(false).then(() => null),
  'update.auto': (a: { on: boolean }) => updater.setAuto(!!a.on),
}

// ---- camera: one ffmpeg shared by every viewer, started on demand, stopped when the last viewer leaves ----
let ff: ChildProcess | null = null
const viewers = new Set<http.ServerResponse>()
const BOUNDARY = 'embercam'
function cameraArgs(copy: boolean): string[] {
  const out = ['-f', 'mpjpeg', '-boundary_tag', BOUNDARY, '-']
  if (CAMERA.startsWith('test:')) return ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-c:v', 'mjpeg', '-q:v', '5', ...out]
  const inp = ['-loglevel', 'error', '-f', 'v4l2', ...(copy ? ['-input_format', 'mjpeg'] : []), '-video_size', process.env.EMBER_CAMERA_SIZE ?? '1280x720', '-framerate', '15', '-i', CAMERA]
  return copy ? [...inp, '-c:v', 'copy', ...out] : [...inp, '-c:v', 'mjpeg', '-q:v', '5', ...out]
}
function startCamera(copy = true) {
  const p = spawn(process.env.EMBER_FFMPEG ?? 'ffmpeg', cameraArgs(copy), { stdio: ['ignore', 'pipe', 'pipe'] })
  ff = p
  const t0 = Date.now()
  let err = ''
  p.stderr?.on('data', (d) => (err += d))
  p.stdout?.on('data', (d: Buffer) => viewers.forEach((v) => v.write(d)))
  p.on('close', () => {
    if (ff !== p) return
    ff = null
    // Webcams that cannot give MJPEG directly: retry once, re-encoding.
    if (copy && Date.now() - t0 < 4000 && viewers.size) return startCamera(false)
    if (err) console.error('camera:', err.trim().split('\n').slice(-2).join(' | '))
    viewers.forEach((v) => v.end())
    viewers.clear()
  })
  p.on('error', (e) => console.error('camera: could not start ffmpeg:', e.message))
}
function addViewer(res: http.ServerResponse) {
  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-store', Connection: 'close' })
  viewers.add(res)
  if (!ff) startCamera()
  res.on('close', () => {
    viewers.delete(res)
    if (!viewers.size)
      setTimeout(() => {
        if (!viewers.size && ff) (ff.kill(), (ff = null))
      }, 3000)
  })
}

// ---- web ----
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' }
const page = (title: string, body: string, js: string) =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Ember</title><body style="font:16px system-ui;background:#14161a;color:#ddd;display:grid;place-items:center;min-height:90vh;margin:0"><form id=f style="width:min(22em,90vw);display:grid;gap:12px"><h2 style="margin:0">🔥 Ember Laser Studio</h2><div style="opacity:.75">${title}</div>${body}<button style="padding:12px;border:0;border-radius:6px;background:#ff5a1f;color:#fff;font:600 16px system-ui">Continue</button><div id=e style="color:#ff8a7a;min-height:1.2em"></div></form><script>${js}</script>`
const inp = 'style="padding:12px;border-radius:6px;border:1px solid #444;background:#1d2026;color:#eee;font:16px system-ui"'
const LOGIN = page('Sign in', `<input name=name placeholder="Name" autocomplete=username autofocus ${inp}><input name=password type=password placeholder="Password" autocomplete=current-password ${inp}>`, `f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({name:f.name.value,password:f.password.value})});const d=await r.json();if(d.ok)location='/';else e2.textContent=d.error};const e2=document.getElementById('e')`)
const SETUP = page('Welcome. Create the owner account for this laser. You can add other people later from the Admin page.', `<input name=name placeholder="Your name" autocomplete=username autofocus ${inp}><input name=password type=password placeholder="Choose a password" autocomplete=new-password ${inp}>`, `f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/setup',{method:'POST',body:JSON.stringify({name:f.name.value,password:f.password.value})});const d=await r.json();if(d.ok)location='/';else e2.textContent=d.error};const e2=document.getElementById('e')`)
const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const readBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve) => {
    let b = ''
    req.on('data', (d) => (b += d).length > 10_000 && req.destroy())
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    const t = url.searchParams.get('token')
    if (t && sameToken(t)) {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, Location: '/' })
      return res.end()
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req)
      try {
        return json(res, 200, { ok: true }, { 'Set-Cookie': setSid(users.login(String(b.name ?? ''), String(b.password ?? ''), ipOf(req))) })
      } catch (e) {
        return json(res, 200, { ok: false, error: (e as Error).message })
      }
    }
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      // The very first account can be made by whoever opens the box first (like a new router or OctoPrint);
      // after that, only the owner link can reset the owner.
      if (!users.empty && !ownerProof(req)) return json(res, 403, { ok: false, error: 'Open the owner link first.' })
      const b = await readBody(req)
      try {
        users.resetOwner(String(b.name ?? ''), String(b.password ?? ''))
        return json(res, 200, { ok: true }, { 'Set-Cookie': setSid(users.openSession(String(b.name).trim())) })
      } catch (e) {
        return json(res, 200, { ok: false, error: (e as Error).message })
      }
    }
    if (url.pathname === '/api/logout') {
      users.logout(cookie(req, SID))
      res.writeHead(302, { 'Set-Cookie': `${SID}=; Path=/; Max-Age=0`, Location: '/login' })
      return res.end()
    }
    const me = userOf(req)
    if (!me) {
      if (users.empty) {
        // First start: the first person to open the box creates the owner account.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(SETUP)
      }
      if (url.pathname === '/setup' && ownerProof(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(SETUP.replace('Welcome. Create the owner account for this laser. You can add other people later from the Admin page.', 'Owner reset: set the admin name and a new password.'))
      }
      res.writeHead(url.pathname === '/login' ? 200 : 401, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(LOGIN)
    }
    if (url.pathname === '/login') {
      res.writeHead(302, { Location: '/' })
      return res.end()
    }
    if (url.pathname === '/camera.mjpg') return addViewer(res)
    if (url.pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ server: true, camera: !!CAMERA, me }))
    }
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/') rel = '/index.html'
    const file = path.normalize(path.join(ROOT, rel))
    if (!file.startsWith(path.resolve(ROOT))) {
      res.writeHead(403)
      return res.end()
    }
    const data = await fs.readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': rel.includes('/assets/') ? 'max-age=31536000, immutable' : 'no-cache' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})

updater.start()
last.set('update', updater.state as unknown as EmberEvent)

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const sid = cookie(req, SID)
  // Refuse sockets opened by other web pages (the browser sends their Origin).
  const origin = req.headers.origin
  const sameOrigin = !origin || (() => { try { return new URL(origin).host === req.headers.host } catch { return false } })()
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !users.who(sid) || !sameOrigin) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, sid))
})
wss.on('connection', (ws: WebSocket, sid: string) => {
  clients.add(ws)
  for (const e of last.values()) ws.send(JSON.stringify({ event: e }))
  ws.on('close', () => clients.delete(ws))
  ws.on('message', async (raw) => {
    let m: { id: number; name: string; args?: unknown }
    try {
      m = JSON.parse(String(raw))
    } catch {
      return
    }
    const h = m.name === 'me' ? () => users.who(sid) : handlers[m.name]
    try {
      const me = users.who(sid)
      if (!me) return ws.close()
      if (!h) throw new Error(`Unknown command ${m.name}`)
      if (!allowed(me.role, m.name)) throw new Error(me.role === 'viewer' ? 'Your account can watch but not control the laser.' : 'Only an admin can do that.')
      // Typing "$32=0" or "$RST=*" in the console changes machine settings too: admin only, like the settings panel.
      if (m.name === 'send' && me.role !== 'admin' && /^\s*\$(\d+\s*=|N\d|RST|I=|SLP)/i.test(String((m.args as { text?: string })?.text ?? ''))) throw new Error('Only an admin can change machine settings.')
      const result = await h(m.args)
      ws.send(JSON.stringify({ id: m.id, ok: true, result: result ?? null }))
    } catch (e) {
      ws.send(JSON.stringify({ id: m.id, ok: false, error: (e as Error).message }))
    }
  })
})

const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address)

// On the box there is no screen: put the addresses and the owner link on the SD card's settings drive so a PC can
// read them. Wi-Fi often comes up after the server, so rewrite the file whenever the addresses change.
let linkWritten = ''
function writeLinkFile() {
  const linkFile = process.env.EMBER_LINKFILE
  if (!linkFile) return
  const ips = lanIps()
  const host = os.hostname()
  const base = PORT === 80 ? '' : `:${PORT}`
  const lines = [
    'Your Ember box',
    '==============',
    '',
    'Everyone uses the laser at:',
    '',
    `  http://${host}.local${base}/`,
    ...ips.map((ip) => `  http://${ip}${base}/`),
    '',
    'They sign in with a name and password the owner creates on the Admin page.',
    '',
    'The first person to open the address creates the owner account.',
    '',
    'OWNER LINK (keep private). Only needed to reset the owner password if it is ever lost:',
    '',
    `  http://${host}.local${base}/?token=${TOKEN}`,
    ...ips.map((ip) => `  http://${ip}${base}/?token=${TOKEN}`),
    '',
    'No network? The box starts its own Wi-Fi called Ember-Setup-.... (password ember1234). Join it and open http://10.42.0.1',
    '',
  ].join('\r\n')
  if (lines === linkWritten) return
  try {
    writeFileSync(linkFile, lines)
    linkWritten = lines
  } catch {
    /* the settings drive may not be mounted */
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIps()
  console.log('Ember server is running.')
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  Open:  http://${ip}:${PORT}/`)
  if (users.empty) console.log('  First time: open it and create the owner account.')
  console.log(`  Owner reset link: http://localhost:${PORT}/?token=${TOKEN}`)
  console.log(`  Camera: ${CAMERA}   Data: ${DATA}   Version: ${versionOf()}`)
  writeLinkFile()
  setInterval(writeLinkFile, 30_000).unref()
})

const shutdown = async () => {
  try {
    controller.emergencyStop()
    await controller.disconnect()
  } catch {
    /* ignore */
  }
  ff?.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
