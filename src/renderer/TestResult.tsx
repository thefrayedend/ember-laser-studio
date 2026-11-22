import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './store'
import { useEscape } from './lib/useEscape'
import { PictureEl, usePicture } from './CameraOverlay'
import { grayOf, scoreGrid, warpToBed, type Cell } from '../core/test/scoreGrid'
import { deleteTest, listTests, saveTest, type TestRecord } from './lib/testLibrary'

const PX_PER_MM = 3
const MAXW = 1600

function toImage(src: HTMLImageElement | HTMLVideoElement | ImageBitmap, sw: number, sh: number): ImageData {
  const k = Math.min(1, MAXW / sw)
  const c = document.createElement('canvas')
  c.width = Math.round(sw * k)
  c.height = Math.round(sh * k)
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.drawImage(src, 0, 0, c.width, c.height)
  return x.getImageData(0, 0, c.width, c.height)
}

export function TestResultDialog() {
  const open = useStore((s) => s.testOpen)
  if (!open) return null
  return <Inner />
}

function Inner() {
  const close = () => useStore.getState().setTestOpen(false)
  useEscape(close)
  const { lastTest, machine, camera, userPresets } = useStore()
  const [lib, setLib] = useState<TestRecord[]>([])
  const [view, setView] = useState<'start' | 'mark' | 'result' | 'library'>('start')
  const [img, setImg] = useState<ImageData | null>(null)
  const [clicks, setClicks] = useState<{ x: number; y: number }[]>([])
  const [best, setBest] = useState<{ c: number; r: number } | null>(null)
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const camOK = camera.on && !!camera.corners
  const { ref: camRef, dims } = usePicture(camOK && view === 'start', camera.deviceId, camera.url)
  const refreshLib = () => void listTests().then(setLib).catch(() => setLib([]))
  useEffect(refreshLib, [])

  const geom = lastTest?.grid ?? null
  const [written, setWritten] = useState('')

  const scored = useMemo(() => {
    if (!img || !geom || clicks.length < 2) return null
    const [a, b] = clicks
    const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
    if (rect.x1 - rect.x0 < 20 || rect.y1 - rect.y0 < 20) return null
    return { rect, ...scoreGrid(grayOf(img.data, img.width, img.height), img.width, img.height, rect, geom) }
  }, [img, geom, clicks])

  // A guess only: the engraving whose darkness is nearest a clean medium burn; for cuts, the fastest square that went through.
  const guess: Cell | null = useMemo(() => {
    if (!scored || !lastTest) return null
    const st = (c: Cell) => lastTest.grid!.cells[c.r * lastTest.grid!.cols + c.c].settings
    if (lastTest.kind === 'engrave') return [...scored.cells].sort((p, q) => Math.abs(p.darkness - 0.55) + p.spread * 0.5 - (Math.abs(q.darkness - 0.55) + q.spread * 0.5))[0]
    const through = scored.cells.filter((c) => c.darkness > 0.6)
    return through.sort((p, q) => (st(q).speed ?? 0) - (st(p).speed ?? 0) || (st(p).passes ?? 1) - (st(q).passes ?? 1) || (st(p).power ?? 0) - (st(q).power ?? 0))[0] ?? null
  }, [scored, lastTest])

  // Draw picture + grid overlay
  useEffect(() => {
    const c = canvas.current
    if (!c || !img) return
    c.width = img.width
    c.height = img.height
    const x = c.getContext('2d')!
    x.putImageData(img, 0, 0)
    x.lineWidth = Math.max(2, img.width / 400)
    clicks.forEach((p) => {
      x.strokeStyle = '#ff5a1f'
      x.beginPath()
      x.arc(p.x, p.y, img.width / 90, 0, 7)
      x.stroke()
    })
    if (scored && geom && lastTest) {
      const { rect } = scored
      const sx = (rect.x1 - rect.x0) / (geom.cols * geom.cell + (geom.cols - 1) * geom.gap)
      const sy = (rect.y1 - rect.y0) / (geom.rows * geom.cell + (geom.rows - 1) * geom.gap)
      x.font = `${Math.max(10, geom.cell * sy * 0.28)}px sans-serif`
      for (const cl of scored.cells) {
        const cx = rect.x0 + cl.c * (geom.cell + geom.gap) * sx
        const cy = rect.y1 - cl.r * (geom.cell + geom.gap) * sy - geom.cell * sy
        const isBest = best && best.c === cl.c && best.r === cl.r
        x.fillStyle = `rgba(255,${Math.round(180 - cl.darkness * 150)},0,${0.15 + cl.darkness * 0.35})`
        x.fillRect(cx, cy, geom.cell * sx, geom.cell * sy)
        x.strokeStyle = isBest ? '#18d36b' : guess && guess.c === cl.c && guess.r === cl.r ? '#ffd400' : 'rgba(255,255,255,.55)'
        x.lineWidth = isBest ? 5 : 2
        x.strokeRect(cx, cy, geom.cell * sx, geom.cell * sy)
        x.fillStyle = '#fff'
        x.fillText(`${Math.round(cl.darkness * 100)}`, cx + 3, cy + geom.cell * sy * 0.35)
      }
    }
  }, [img, clicks, scored, best, guess, geom, lastTest])

  const load = async (f: File) => {
    try {
      const bm = await createImageBitmap(f)
      setImg(toImage(bm, bm.width, bm.height))
      setClicks([])
      setBest(null)
      setView(lastTest?.grid ? 'mark' : 'result')
    } catch {
      setErr('Could not read that picture.')
    }
  }
  const snap = () => {
    const el = camRef.current
    if (!el || !dims.w || !camera.corners) return setErr('The camera is not showing a picture yet.')
    try {
      const full = toImage(el, dims.w, dims.h)
      const k = full.width / dims.w
      const w = warpToBed(full.data, full.width, full.height, camera.corners.map((p) => ({ x: p.x * k, y: p.y * k })), machine.bedWidth, machine.bedHeight, PX_PER_MM)
      setImg(new ImageData(w.data, w.w, w.h))
      setClicks([])
      setBest(null)
      setView(lastTest?.grid ? 'mark' : 'result')
    } catch (e) {
      setErr('Could not take the photo: ' + (e as Error).message)
    }
  }
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvas.current!
    const r = c.getBoundingClientRect()
    const p = { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
    if (scored && geom) {
      const { rect } = scored
      const sx = (rect.x1 - rect.x0) / (geom.cols * geom.cell + (geom.cols - 1) * geom.gap)
      const sy = (rect.y1 - rect.y0) / (geom.rows * geom.cell + (geom.rows - 1) * geom.gap)
      const col = Math.floor((p.x - rect.x0) / ((geom.cell + geom.gap) * sx))
      const row = Math.floor((rect.y1 - p.y) / ((geom.cell + geom.gap) * sy))
      if (col >= 0 && col < geom.cols && row >= 0 && row < geom.rows) setBest({ c: col, r: row })
      return
    }
    const next = [...clicks, p]
    setClicks(next)
    if (next.length === 2) setView('result')
  }

  const blobOf = () => new Promise<Blob>((res) => {
    const c = document.createElement('canvas')
    c.width = img!.width
    c.height = img!.height
    c.getContext('2d')!.putImageData(img!, 0, 0)
    c.toBlob((b) => res(b!), 'image/jpeg', 0.85)
  })

  const cellText = (b: { c: number; r: number } | null | undefined) => (b && geom ? geom.cells[b.r * geom.cols + b.c]?.text : undefined)
  const save = async () => {
    if (!img || !lastTest || !name.trim()) return setErr('Give it a name, such as "3 mm birch ply".')
    const rec: TestRecord = { id: 't' + Date.now(), at: Date.now(), name: name.trim(), kind: lastTest.kind, title: lastTest.title, result: cellText(best) ?? (written.trim() || undefined), best: best ?? undefined, image: await blobOf() }
    await saveTest(rec)
    const cell = best && geom ? geom.cells[best.r * geom.cols + best.c] : null
    if (cell) {
      const id = 'user-test-' + rec.id
      if (!userPresets.some((p) => p.id === id))
        useStore.getState().addUserPreset({
          id,
          name: rec.name + ` (${lastTest.title.replace(/ test$/, '').toLowerCase()})`,
          material: 'My presets',
          operation: lastTest.kind === 'cut' ? 'cut' : 'engrave',
          settings: { mode: lastTest.kind === 'cut' ? 'line' : 'fill', passes: 1, lineInterval: 0.1, ...cell.settings },
          note: 'From a camera-rated material test.',
        })
    }
    useStore.getState().notify('ok', cell ? 'Saved the test and a preset.' : 'Saved the test.')
    refreshLib()
    setView('library')
  }

    const urls = useMemo(() => lib.map((t) => URL.createObjectURL(t.image)), [lib])
  useEffect(() => () => urls.forEach(URL.revokeObjectURL), [urls])

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Rate a material test</h2>
        <div className="seg">
          <button className={view !== 'library' ? 'on' : ''} onClick={() => setView(img ? (clicks.length >= 2 ? 'result' : 'mark') : 'start')}>This test</button>
          <button className={view === 'library' ? 'on' : ''} onClick={() => setView('library')}>Saved tests ({lib.length})</button>
        </div>
        {err && <p className="err">{err}</p>}
        {view !== 'library' && !lastTest && <p className="hint">Build a material test first (the ▦ button), burn it, then come back here.</p>}
        {view === 'start' && lastTest && (
          <>
            <p className="hint">Burned. The laser went back to its start point, so the test is sitting under the camera. Take a photo, or choose one you took (from straight above, whole grid in view).</p>
            {camOK ? (
              <>
                <div style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}>
                  <PictureEl url={camera.url} elRef={camRef} style={{}} />
                </div>
                <button className="primary" disabled={!dims.w} onClick={snap}>{dims.w ? 'Take photo with the camera' : 'Waiting for the camera…'}</button>
              </>
            ) : (
              <p className="hint">The camera is not set up (or not switched on), so use a photo instead. Setting up the camera overlay lets this take the photo for you.</p>
            )}
            <label className="field"><span>Or choose a photo</span><input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} /></label>
          </>
        )}
        {(view === 'mark' || view === 'result') && lastTest && img && (
          <>
            <p className="hint">
              {geom
                ? clicks.length < 2
                  ? `Click the ${clicks.length === 0 ? 'top-left' : 'bottom-right'} corner of the whole test grid.`
                  : 'Each square shows how dark it is (0 = like the plain material, 100 = black). Yellow outline: my guess. Click the square you like best (green).'
                : 'Look over the photo, then write down what you found.'}
              {' '}{lastTest.note}
            </p>
            <canvas ref={canvas} onClick={onClick} style={{ width: '100%', maxHeight: '55vh', objectFit: 'contain', cursor: geom ? 'crosshair' : 'default', background: '#000' }} />
            {geom && (
              <div className="modal-actions">
                <button onClick={() => (setClicks([]), setBest(null), setView('mark'))}>Redo corners</button>
                {guess && <button onClick={() => setBest({ c: guess.c, r: guess.r })}>Use my guess</button>}
              </div>
            )}
            {(scored || !geom) && (
              <>
                {geom ? (
                  <p className="hint">Dark scores depend on lighting, so treat them as a guide. {best ? `Chosen: ${cellText(best)}.` : 'Pick a square to also save a preset.'}</p>
                ) : (
                  <label className="field"><span>{lastTest.prompt ?? 'What did you find?'}</span><input value={written} onChange={(e) => setWritten(e.target.value)} /></label>
                )}
                <label className="field"><span>Material name</span><input value={name} placeholder="e.g. 3 mm birch ply" onChange={(e) => setName(e.target.value)} /></label>
                <div className="modal-actions"><button className="primary" onClick={() => void save()}>Save photo{best ? ' and make a preset' : ''}</button></div>
              </>
            )}
          </>
        )}
        {view === 'library' && (
          <div style={{ display: 'grid', gap: 10 }}>
            {lib.length === 0 && <p className="hint">No saved tests yet.</p>}
            {lib.map((t, i) => (
              <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <a href={urls[i]} target="_blank" rel="noreferrer"><img src={urls[i]} alt="" style={{ width: 96, height: 72, objectFit: 'cover' }} /></a>
                <div style={{ flex: 1 }}>
                  <b>{t.name}</b> <span className="hint">{new Date(t.at).toLocaleDateString()} · {t.title}</span>
                  <div className="hint">{t.result ? `Result: ${t.result}` : 'No result noted'}</div>
                </div>
                <button onClick={() => void deleteTest(t.id).then(refreshLib)}>Delete</button>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions"><button onClick={() => (close(), useStore.getState().setHelpOpen('rate'))}>Help</button><button onClick={close}>Close</button></div>
      </div>
    </div>
  )
}
