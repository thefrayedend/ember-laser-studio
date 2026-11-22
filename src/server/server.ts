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
const COOKIE = 'ember_auth'
const sameToken = (a: string) => a.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(TOKEN))
const cookieOf = (req: http.IncomingMessage) => /(?:^|;\s*)ember_auth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
const authed = (req: http.IncomingMessage) => sameToken(decodeURIComponent(cookieOf(req)))

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
const handlers: Record<string, (a: any) => unknown> = {
  ...coreHandlers(controller),
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
const LOCKED = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Ember</title><body style="font:16px system-ui;background:#14161a;color:#ddd;padding:3em;max-width:34em"><h2>Ember Laser Studio</h2><p>Open the link that was printed when the server started (it ends in <code>/?token=…</code>), or run <code>cat ${tokenFile.replace(/</g, '')}</code> on the laser box.</p>`

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    const t = url.searchParams.get('token')
    if (t && sameToken(t)) {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, Location: '/' })
      return res.end()
    }
    if (!authed(req)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(LOCKED)
    }
    if (url.pathname === '/camera.mjpg') return addViewer(res)
    if (url.pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ server: true, camera: !!CAMERA }))
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
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !authed(req)) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})
wss.on('connection', (ws) => {
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
    const h = handlers[m.name]
    try {
      if (!h) throw new Error(`Unknown command ${m.name}`)
      const result = await h(m.args)
      ws.send(JSON.stringify({ id: m.id, ok: true, result: result ?? null }))
    } catch (e) {
      ws.send(JSON.stringify({ id: m.id, ok: false, error: (e as Error).message }))
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address)
  console.log('Ember server is running.')
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  Open:  http://${ip}:${PORT}/?token=${TOKEN}`)
  console.log(`  Camera: ${CAMERA}   Data: ${DATA}   Version: ${versionOf()}`)
  // On the box there is no screen: put the private link on the SD card's settings drive so a PC can read it.
  const linkFile = process.env.EMBER_LINKFILE
  if (linkFile) {
    const host = os.hostname()
    const base = PORT === 80 ? '' : `:${PORT}`
    const lines = ['Your Ember box', '==============', '', 'Open this link once on each phone, tablet or computer (keep it private: it lets people run your laser):', '', `  http://${host}.local${base}/?token=${TOKEN}`, '', 'If that does not open, use the box address instead:', '', ...ips.map((ip) => `  http://${ip}${base}/?token=${TOKEN}`), '']
    try {
      writeFileSync(linkFile, lines.join('\r\n'))
    } catch {
      /* the settings drive may not be mounted */
    }
  }
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
