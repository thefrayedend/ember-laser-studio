import { useEscape } from './lib/useEscape'
import { useEffect, useRef, useState } from 'react'
import { useStore, type CameraCfg } from './store'
import { isRemote } from './lib/transport'
import { cssMatrix3d, quadToQuad, type P2 } from '../core/geometry/homography'
import { calibrationPoints, designToWork, detectDot, fitCamera } from '../core/geometry/dotDetect'

async function openStream(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  })
}

type Pic = HTMLVideoElement | HTMLImageElement

/** The camera picture: a webcam on this computer, or a network (MJPEG) stream such as the one the laser box serves. */
export function usePicture(enabled: boolean, deviceId: string, url: string) {
  const ref = useRef<Pic | null>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDims({ w: 0, h: 0 })
    if (!enabled) return
    setError(null)
    if (url) {
      // An MJPEG <img> never fires "load", so wait until the first frame gives it a size.
      const t = setInterval(() => {
        const im = ref.current as HTMLImageElement | null
        if (im && im.naturalWidth) {
          setDims({ w: im.naturalWidth, h: im.naturalHeight })
          clearInterval(t)
        }
      }, 250)
      const to = setTimeout(() => setError((e) => e ?? 'No picture yet from that address. Check it and that the camera is on.'), 8000)
      return () => {
        clearInterval(t)
        clearTimeout(to)
        if (ref.current instanceof HTMLImageElement) ref.current.src = '' // closes the stream so the box can stop its camera
      }
    }
    let stream: MediaStream | undefined
    let dead = false
    openStream(deviceId)
      .then((s) => {
        if (dead) return s.getTracks().forEach((t) => t.stop())
        stream = s
        const v = ref.current as HTMLVideoElement | null
        if (!v) return
        v.srcObject = s
        v.onloadedmetadata = () => {
          void v.play()
          setDims({ w: v.videoWidth, h: v.videoHeight })
        }
      })
      .catch((e: Error) => setError(e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in Windows Settings → Privacy → Camera.' : 'Could not open the camera: ' + e.message))
    return () => {
      dead = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [enabled, deviceId, url])
  return { ref, dims, error }
}

export function PictureEl({ url, elRef, style }: { url: string; elRef: React.MutableRefObject<Pic | null>; style: React.CSSProperties }) {
  return url ? (
    <img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={url} crossOrigin="anonymous" alt="" style={style} />
  ) : (
    <video ref={elRef as React.MutableRefObject<HTMLVideoElement | null>} muted playsInline style={style} />
  )
}

/** Live camera picture warped onto the bed, drawn underneath the design canvas. */
export function CameraLayer({ view }: { view: { k: number; ox: number; oy: number } }) {
  const cam = useStore((s) => s.camera)
  const machine = useStore((s) => s.machine)
  const active = cam.on && !!cam.corners
  const { ref, dims } = usePicture(active, cam.deviceId, cam.url)
  if (!active) return null
  let transform = 'none'
  if (dims.w && cam.corners) {
    try {
      const dst = [
        { x: view.ox, y: view.oy },
        { x: view.ox + machine.bedWidth * view.k, y: view.oy },
        { x: view.ox + machine.bedWidth * view.k, y: view.oy + machine.bedHeight * view.k },
        { x: view.ox, y: view.oy + machine.bedHeight * view.k },
      ]
      transform = cssMatrix3d(quadToQuad(cam.corners, dst))
    } catch {
      /* bad corners: show nothing warped */
    }
  }
  return (
    <PictureEl
      url={cam.url}
      elRef={ref}
      style={{ position: 'absolute', left: 0, top: 0, width: dims.w || undefined, height: dims.h || undefined, transformOrigin: '0 0', transform, opacity: cam.opacity, pointerEvents: 'none', visibility: dims.w ? 'visible' : 'hidden' }}
    />
  )
}

const LABELS = ['top-left', 'top-right', 'bottom-right', 'bottom-left']

export function CameraDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  const cam = useStore((s) => s.camera)
  const { setCamera } = useStore.getState()
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState(cam.deviceId)
  const [url, setUrl] = useState(cam.url || (isRemote() && !cam.corners ? '/camera.mjpg' : ''))
  const [corners, setCorners] = useState<P2[]>(cam.corners ?? [])
  const { ref, dims, error } = usePicture(true, deviceId, url)
  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === 'videoinput')))
      .catch(() => undefined)
  }, [dims.w])
  const SHOW_W = 520
  const scale = dims.w ? SHOW_W / dims.w : 1
  const [wiz, setWiz] = useState(false)
  const clickHook = useRef<((p: P2) => void) | null>(null)
  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dims.w) return
    const r = e.currentTarget.getBoundingClientRect()
    const p = { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
    if (clickHook.current) return clickHook.current(p)
    if (corners.length >= 4) return
    setCorners([...corners, p])
  }
  const done = corners.length === 4
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Camera overlay</h2>
        <p className="hint">Show your material on the design canvas. Point a camera at the bed, then click the four corners of the work area in the picture, in the order shown below.</p>
        <label className="field">
          <span>Camera</span>
          <select value={url ? 'net' : deviceId} onChange={(e) => (e.target.value === 'net' ? setUrl(isRemote() ? '/camera.mjpg' : 'http://') : (setUrl(''), setDeviceId(e.target.value)), setCorners([]))}>
            <option value="">Default camera on this computer</option>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
            <option value="net">{isRemote() ? 'Camera on the laser box' : 'Network camera (stream address)'}</option>
          </select>
        </label>
        {url && !isRemote() && (
          <label className="field">
            <span>Stream address</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.60/stream" />
          </label>
        )}
        {error && <p className="alarm">{error}</p>}
        <div style={{ position: 'relative', width: SHOW_W, height: dims.h * scale || 360, background: '#000', cursor: done ? 'default' : 'crosshair' }} onClick={click}>
          <PictureEl url={url} elRef={ref} style={{ width: SHOW_W, display: 'block' }} />
          {corners.map((c, i) => (
            <div key={i} style={{ position: 'absolute', left: c.x * scale - 7, top: c.y * scale - 7, width: 14, height: 14, borderRadius: 7, background: '#ff6a2b', color: '#000', fontSize: 10, textAlign: 'center', lineHeight: '14px', pointerEvents: 'none' }}>{i + 1}</div>
          ))}
        </div>
        <p className="hint">{done ? 'All four corners set.' : `Click the ${LABELS[corners.length]} corner of the work area (${corners.length + 1} of 4). "Top-left" is the back-left corner as drawn on the design canvas.`}</p>
        {wiz ? (
          <LaserWizard
            videoRef={ref}
            dims={dims}
            clickHook={clickHook}
            onClose={() => setWiz(false)}
            onResult={(c) => (setCorners(c), setWiz(false))}
          />
        ) : (
          <p className="hint">
            <button onClick={() => (setCorners([]), setWiz(true))}>Calibrate with the laser</button> instead: the head visits four spots and Ember finds its dot in the picture.
          </p>
        )}
        <div className="modal-actions">
          <button onClick={() => setCorners([])}>Start over</button>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!done}
            onClick={() => {
              try {
                quadToQuad(corners, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])
              } catch (e) {
                return useStore.getState().notify('error', (e as Error).message)
              }
              setCamera({ deviceId, url, corners, on: true })
              onClose()
            }}
          >
            Save and show
          </button>
        </div>
      </div>
    </div>
  )
}

export const defaultCamera: CameraCfg = { on: false, deviceId: '', url: '', corners: null, opacity: 0.7 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Corner = 'fl' | 'fr' | 'bl' | 'br'
const CORNER_NAMES: Record<Corner, string> = { fl: 'front-left', fr: 'front-right', bl: 'back-left', br: 'back-right' }

/** Moves the head to known spots, pulses a weak dot, and finds it in the camera picture. */
function LaserWizard({
  videoRef,
  dims,
  clickHook,
  onClose,
  onResult,
}: {
  videoRef: React.MutableRefObject<Pic | null>
  dims: { w: number; h: number }
  clickHook: React.MutableRefObject<((p: P2) => void) | null>
  onClose: () => void
  onResult: (corners: P2[]) => void
}) {
  const machine = useStore((s) => s.machine)
  const status = useStore((s) => s.status)
  const connected = useStore((s) => s.conn.connected)
  const job = useStore((s) => s.job)
  const [corner, setCorner] = useState<Corner>('fl')
  const [pct, setPct] = useState(3)
  const [step, setStep] = useState(10)
  const [phase, setPhase] = useState<'setup' | 'run' | 'done'>('setup')
  const [msg, setMsg] = useState('')
  const [found, setFound] = useState<P2[]>([])
  const [report, setReport] = useState<{ corners: P2[]; err: number | null } | null>(null)
  const cancel = useRef(false)
  const api = useStore.getState().api
  const ready = connected && status && status.state !== 'Disconnected' && !job
  const W = machine.bedWidth
  const H = machine.bedHeight

  const grab = (): Uint8ClampedArray | null => {
    const v = videoRef.current
    if (!v) return null
    const vw = v instanceof HTMLVideoElement ? v.videoWidth : v.naturalWidth
    const vh = v instanceof HTMLVideoElement ? v.videoHeight : v.naturalHeight
    if (!vw) return null
    const cw = 480
    const ch = Math.round((cw * vh) / vw)
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(v, 0, 0, cw, ch)
    try {
      return g.getImageData(0, 0, cw, ch).data
    } catch {
      return null // a camera that does not allow reading its picture: only clicking the dot works
    }
  }
  const gw = 480
  const gh = dims.w ? Math.round((gw * dims.h) / dims.w) : 270

  const waitIdle = async () => {
    await sleep(400)
    for (let i = 0; i < 600; i++) {
      const st = useStore.getState()
      if (!st.job && st.status?.state === 'Idle') return
      if (cancel.current) return
      await sleep(100)
    }
    throw new Error('The machine did not finish moving.')
  }
  const moveTo = async (x: number, y: number) => {
    await api('job.start', { lines: ['G21 G90', 'M5', `G0 X${x.toFixed(3)} Y${y.toFixed(3)}`, 'G4 P0.4'], name: 'calibrate', where: 'pc' })
    await waitIdle()
    await sleep(500) // let the camera settle after the head stops
  }

  const run = async () => {
    const head = useStore.getState().status?.wpos
    if (!head) return
    const home = { x: head.x, y: head.y }
    const def = { fl: { cx: 0, cy: H }, fr: { cx: W, cy: H }, bl: { cx: 0, cy: 0 }, br: { cx: W, cy: 0 } }[corner]
    const pts = calibrationPoints(W, H)
    const seen: P2[] = []
    cancel.current = false
    setPhase('run')
    setFound([])
    try {
      for (let i = 0; i < pts.length; i++) {
        if (cancel.current) throw new Error('cancelled')
        const t = designToWork(pts[i].x, pts[i].y, def, home)
        setMsg(`Point ${i + 1} of ${pts.length}: moving…`)
        await moveTo(t.x, t.y)
        // reference picture with the laser off
        const frames: Uint8ClampedArray[] = []
        for (let k = 0; k < 3; k++) {
          const f = grab()
          if (f) frames.push(f)
          await sleep(120)
        }
        if (!frames.length) throw new Error('Cannot read the camera picture (this camera address does not allow it). Use the four-click setup instead.')
        const base = new Uint8ClampedArray(frames[0].length)
        for (let k = 0; k < base.length; k++) base[k] = frames.reduce((a, f) => a + f[k], 0) / frames.length
        setMsg(`Point ${i + 1} of ${pts.length}: looking for the dot…`)
        let manual: P2 | null = null
        clickHook.current = (p) => (manual = p)
        const fire = setInterval(() => void api('pulse', { pct, maxS: machine.maxS }), 350)
        void api('pulse', { pct, maxS: machine.maxS })
        let best: { x: number; y: number; score: number } | null = null
        const t0 = Date.now()
        try {
          while (Date.now() - t0 < 3500 && !manual && !cancel.current) {
            const f = grab()
            if (f) {
              const d = detectDot(base, f, gw, gh)
              if (d && (!best || d.score > best.score)) best = d
            }
            await sleep(80)
          }
          if (!best && !manual && !cancel.current) {
            setMsg(`Point ${i + 1} of ${pts.length}: I can't see the dot. Click it in the picture if you can see it (waiting 15 s).`)
            const t1 = Date.now()
            while (Date.now() - t1 < 15000 && !manual && !cancel.current) await sleep(80)
          }
        } finally {
          clearInterval(fire)
          clickHook.current = null
        }
        if (cancel.current) throw new Error('cancelled')
        const at: P2 | null = manual ?? (best ? { x: (best.x * dims.w) / gw, y: (best.y * dims.h) / gh } : null)
        if (!at) throw new Error(`Could not find the dot at point ${i + 1}. Raise the dot power, dim the room, or put a sheet of paper on the bed, then try again.`)
        seen.push(at)
        setFound([...seen])
      }
      const fit = fitCamera(pts, seen, W, H)
      setReport({ corners: fit.corners, err: fit.checkErrorPx })
      setPhase('done')
      setMsg('')
      await moveTo(home.x, home.y).catch(() => undefined)
    } catch (e) {
      const m = (e as Error).message
      setMsg(m === 'cancelled' ? 'Cancelled.' : m)
      setPhase('setup')
      await api('job.stop').catch(() => undefined)
      await moveTo(home.x, home.y).catch(() => undefined)
    }
  }
  useEffect(
    () => () => {
      cancel.current = true
      clickHook.current = null
    },
    [clickHook],
  )

  const go = (x: number, y: number) => api('jog', { x: x || undefined, y: y || undefined, feed: 3000 })
  return (
    <div className="subpanel" data-testid="laser-wizard">
      <h3>Calibrate with the laser</h3>
      {phase === 'setup' && (
        <>
          <p className="hint">
            <b>Safety:</b> the laser will pulse weakly at four spots. Wear your laser glasses, close the lid if you can, and put a sheet of paper or scrap on the bed. Keep the machine's emergency stop in reach.
          </p>
          <ol className="steps">
            <li>Use the arrows to move the head to one <b>corner of the usable area</b> (as far as you want the camera to cover).</li>
            <li>Tell Ember which corner that is.</li>
            <li>Press Start. The head moves inward from there, so it will never drive past the corner you set.</li>
          </ol>
          <div className="jogpad">
            <span /><button disabled={!ready} onClick={() => go(0, step)}>▲</button><span />
            <button disabled={!ready} onClick={() => go(-step, 0)}>◀</button>
            <button disabled={!ready} onClick={() => api('jogCancel')}>■</button>
            <button disabled={!ready} onClick={() => go(step, 0)}>▶</button>
            <span /><button disabled={!ready} onClick={() => go(0, -step)}>▼</button><span />
          </div>
          <div className="seg five">
            {[1, 10, 50, 100, 200].map((v) => <button key={v} className={step === v ? 'on' : ''} onClick={() => setStep(v)}>{v}</button>)}
          </div>
          <p className="hint">Head is at X {status?.wpos.x.toFixed(1) ?? '–'}, Y {status?.wpos.y.toFixed(1) ?? '–'}.</p>
          <div className="grid2">
            <label className="field">
              <span>The head is at the bed's</span>
              <select value={corner} onChange={(e) => setCorner(e.target.value as Corner)}>
                {(Object.keys(CORNER_NAMES) as Corner[]).map((c) => <option key={c} value={c}>{CORNER_NAMES[c]} corner</option>)}
              </select>
            </label>
            <label className="field">
              <span>Dot power %</span>
              <input type="number" min={1} max={10} value={pct} onChange={(e) => setPct(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
            </label>
          </div>
          {!connected && <p className="hint">Connect to your laser on the Device tab first (the simulator works too).</p>}
          {msg && <p className="alarm">{msg}</p>}
          <div className="modal-actions">
            <button onClick={onClose}>Back to manual</button>
            <button className="primary" disabled={!ready || !dims.w} onClick={() => void run()}>Start</button>
          </div>
        </>
      )}
      {phase === 'run' && (
        <>
          <p>{msg}</p>
          <p className="hint">Found {found.length} so far. If the dot is visible but not detected, just click it in the picture above.</p>
          <div className="modal-actions">
            <button onClick={() => (cancel.current = true)}>Stop</button>
          </div>
        </>
      )}
      {phase === 'done' && report && (
        <>
          <p>
            Done. {report.err !== null && (report.err < 6 ? `The check point agreed to within ${report.err.toFixed(1)} px, which is good.` : `The check point was ${report.err.toFixed(1)} px off. The lens may be bending the picture; try mounting the camera higher, or run it again.`)}
          </p>
          <div className="modal-actions">
            <button onClick={() => setPhase('setup')}>Run again</button>
            <button className="primary" onClick={() => onResult(report.corners)}>Use these corners</button>
          </div>
        </>
      )}
    </div>
  )
}
