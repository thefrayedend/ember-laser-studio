import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from './lib/theme'
import { textShape } from './lib/fonts'
import { Circle, Ellipse, Image as KImage, Layer, Line, Path, Rect, Stage, Text, Transformer } from 'react-konva'
import type Konva from 'konva'
import { useStore } from './store'
import { CameraDialog, CameraLayer } from './CameraOverlay'
import { getAsset } from './lib/assets'
import { ellipsePath, polygonPath, rectPath, starPath } from '../core/geometry/path'
import type { DesignObject } from '../core/document'

interface View {
  k: number // px per mm
  ox: number
  oy: number
}

const DARK = { bed: '#1a1d23', bedLine: '#3a404b', gridMajor: '#2c323c', grid: '#21262e', axis: '#6b7380', anchor: '#14161a' }
const LIGHT = { bed: '#ffffff', bedLine: '#aab2bf', gridMajor: '#d3d8e0', grid: '#eceff3', axis: '#7a8493', anchor: '#ffffff' }

export function DesignCanvas() {
  const P = useTheme() === 'light' ? LIGHT : DARK
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ k: 1, ox: 0, oy: 0 })
  const [fitted, setFitted] = useState(false)
  const [camOpen, setCamOpen] = useState(false)
  const camera = useStore((s) => s.camera)
  const camShown = camera.on && !!camera.corners
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const panning = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const doc = useStore((s) => s.doc)
  const machine = useStore((s) => s.machine)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const status = useStore((s) => s.status)
  const assetVersion = useStore((s) => s.assetVersion)
  const { select, updateObject, setTool, addShape, addText } = useStore.getState()

  useEffect(() => {
    const el = wrapRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const touched = useRef(false)
  const fit = () => {
    const pad = 28
    const hh = size.h - 36 // leave room for the zoom buttons
    const k = Math.min((size.w - pad * 2) / machine.bedWidth, (hh - pad * 2) / machine.bedHeight)
    setView({ k, ox: (size.w - machine.bedWidth * k) / 2, oy: (hh - machine.bedHeight * k) / 2 })
  }
  useEffect(() => {
    if (size.w > 100 && size.h > 100 && !touched.current) {
      fit()
      setFitted(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, fitted])
  useEffect(() => {
    if (fitted) fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.bedWidth, machine.bedHeight])

  // Attach the transformer to the selected nodes.
  useEffect(() => {
    const stage = stageRef.current
    const tr = trRef.current
    if (!stage || !tr) return
    const nodes = selection.map((id) => stage.findOne('#' + id)).filter(Boolean) as Konva.Node[]
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selection, doc, tool])

  const layerColor = useMemo(() => Object.fromEntries(doc.layers.map((l) => [l.id, l])), [doc.layers])

  const toMm = (): { x: number; y: number } | null => {
    const p = stageRef.current?.getPointerPosition()
    if (!p) return null
    return { x: (p.x - view.ox) / view.k, y: (p.y - view.oy) / view.k }
  }

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const p = stageRef.current!.getPointerPosition()!
    const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12
    const k = Math.max(0.2, Math.min(40, view.k * factor))
    const mx = (p.x - view.ox) / view.k
    const my = (p.y - view.oy) / view.k
    touched.current = true
    setView({ k, ox: p.x - mx * k, oy: p.y - my * k })
  }

  const onDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const onEmpty = e.target === e.target.getStage() || e.target.attrs.name === 'bed'
    if (e.evt.button === 1 || (tool === 'select' && onEmpty && e.evt.button === 0)) {
      const p = stageRef.current!.getPointerPosition()!
      panning.current = { sx: p.x, sy: p.y, ox: view.ox, oy: view.oy }
      if (onEmpty) select([])
      return
    }
    if (tool === 'select') return
    const m = toMm()
    if (!m) return
    if (tool === 'text') {
      addText(m)
      setTool('select')
      return
    }
    dragStart.current = m
    setDraft({ x: m.x, y: m.y, w: 0, h: 0 })
  }
  const onMove = () => {
    if (panning.current) {
      const p = stageRef.current!.getPointerPosition()!
      touched.current = true
      setView((v) => ({ ...v, ox: panning.current!.ox + p.x - panning.current!.sx, oy: panning.current!.oy + p.y - panning.current!.sy }))
      return
    }
    const s = dragStart.current
    const m = toMm()
    if (s && m) setDraft({ x: Math.min(s.x, m.x), y: Math.min(s.y, m.y), w: Math.abs(m.x - s.x), h: Math.abs(m.y - s.y) })
  }
  const onUp = () => {
    panning.current = null
    if (!dragStart.current || !draft) return
    dragStart.current = null
    let { x, y, w, h } = draft
    if (w < 2 && h < 2) {
      w = h = 30 // a plain click makes a default-sized shape
      const m = toMm()!
      x = m.x - 15
      y = m.y - 15
    }
    w = Math.max(1, w)
    h = Math.max(1, h)
    const d = tool === 'rect' ? rectPath(w, h) : tool === 'ellipse' ? ellipsePath(w, h) : tool === 'polygon' ? polygonPath(6, w, h) : starPath(5, w, h)
    const id = addShape(tool as 'rect' | 'ellipse' | 'polygon' | 'star', d, w, h, { x: x + w / 2, y: y + h / 2 })
    void id
    setDraft(null)
    setTool('select')
  }

  const grid = useMemo(() => {
    const lines: { pts: number[]; major: boolean }[] = []
    for (let x = 0; x <= machine.bedWidth; x += 10) lines.push({ pts: [x, 0, x, machine.bedHeight], major: x % 50 === 0 })
    for (let y = 0; y <= machine.bedHeight; y += 10) lines.push({ pts: [0, y, machine.bedWidth, y], major: y % 50 === 0 })
    return lines
  }, [machine.bedWidth, machine.bedHeight])

  const renderObj = (o: DesignObject) => {
    const l = layerColor[o.layerId]
    if (!l || !l.visible) return null
    const common = {
      key: o.id,
      id: o.id,
      x: o.x,
      y: o.y,
      rotation: o.rotation,
      scaleX: o.scaleX,
      scaleY: o.scaleY,
      draggable: tool === 'select',
      onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
        if (tool !== 'select') return
        if (e.evt.shiftKey) {
          const cur = useStore.getState().selection
          select(cur.includes(o.id) ? cur.filter((i) => i !== o.id) : [...cur, o.id])
        } else select([o.id])
      },
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => updateObject(o.id, { x: e.target.x(), y: e.target.y() }),
      onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
        const n = e.target
        updateObject(o.id, { x: n.x(), y: n.y(), rotation: n.rotation(), scaleX: n.scaleX(), scaleY: n.scaleY() })
      },
      opacity: l.output ? 1 : 0.35,
    }
    if (o.type === 'path') {
      return (
        <Path
          {...common}
          data={o.d}
          stroke={l.color}
          strokeWidth={1.6}
          strokeScaleEnabled={false}
          fill={l.mode === 'fill' ? l.color + '55' : 'rgba(0,0,0,0.01)'}
          hitStrokeWidth={10}
        />
      )
    }
    if (o.type === 'image') {
      const a = getAsset(o.assetId)
      if (!a) return null
      return <KImage {...common} image={a.el} width={o.widthMm} height={o.heightMm} opacity={l.output ? 0.9 : 0.3} />
    }
    const shape = textShape(o)
    if (shape)
      return <Path {...common} data={shape.d} fill={l.mode === 'fill' ? l.color : undefined} stroke={l.color} strokeWidth={l.mode === 'fill' ? 0.2 : 1.2} strokeScaleEnabled={false} hitStrokeWidth={10} />
    return (
      <Text
        {...common}
        text={o.text}
        fontFamily={o.fontFamily}
        fontSize={o.fontSizeMm}
        fontStyle={`${o.italic ? 'italic ' : ''}${o.bold ? 'bold' : 'normal'}`}
        lineHeight={1.2}
        fill={l.color}
      />
    )
  }
  void assetVersion

  // Live head position marker (machine coords -> design coords through the origin used for the bed view).
  const head = useMemo(() => {
    if (!status || status.state === 'Disconnected') return null
    const c = machine.originCorner
    const x = c.endsWith('l') ? status.mpos.x : status.mpos.x + machine.bedWidth
    const y = c.startsWith('b') ? machine.bedHeight - status.mpos.y : -status.mpos.y
    return { x, y }
  }, [status, machine])

  const cursor = tool === 'select' ? 'default' : 'crosshair'

  return (
    <div ref={wrapRef} className="canvas-wrap" style={{ cursor, overflow: 'hidden' }}>
      <CameraLayer view={view} />
      <div style={{ position: 'absolute', inset: 0 }}>
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={view.ox}
        y={view.oy}
        scaleX={view.k}
        scaleY={view.k}
        onWheel={onWheel}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => (panning.current = null)}
      >
        <Layer listening={true}>
          <Rect name="bed" x={0} y={0} width={machine.bedWidth} height={machine.bedHeight} fill={camShown ? "rgba(26,29,35,0.02)" : P.bed} stroke={P.bedLine} strokeWidth={1} strokeScaleEnabled={false} />
          {grid.map((g, i) => (
            <Line key={i} points={g.pts} stroke={g.major ? P.gridMajor : P.grid} strokeWidth={1} strokeScaleEnabled={false} listening={false} />
          ))}
          {[0, 50, 100, 150, 200, 250, 300, 350, 400].filter((v) => v <= machine.bedWidth).map((v) => (
            <Text key={'x' + v} x={v + 1} y={machine.bedHeight + 2} text={String(v)} fontSize={5} fill={P.axis} listening={false} />
          ))}
          {[50, 100, 150, 200, 250, 300, 350, 400].filter((v) => v <= machine.bedHeight).map((v) => (
            <Text key={'y' + v} x={-14} y={machine.bedHeight - v - 2} text={String(v)} fontSize={5} fill={P.axis} listening={false} />
          ))}
          <Circle x={0} y={machine.bedHeight} radius={3} fill="#ff6a2b" listening={false} />
          {doc.objects.map(renderObj)}
          {draft && tool !== 'select' && (
            <>
              {tool === 'ellipse' ? (
                <Ellipse x={draft.x + draft.w / 2} y={draft.y + draft.h / 2} radiusX={draft.w / 2} radiusY={draft.h / 2} stroke="#ff6a2b" dash={[4, 3]} strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
              ) : (
                <Rect x={draft.x} y={draft.y} width={draft.w} height={draft.h} stroke="#ff6a2b" dash={[4, 3]} strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
              )}
            </>
          )}
          {head && (
            <>
              <Circle x={head.x} y={head.y} radius={2.2} stroke="#3ddc84" strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
              <Line points={[head.x - 6, head.y, head.x + 6, head.y]} stroke="#3ddc84" strokeWidth={1} strokeScaleEnabled={false} listening={false} />
              <Line points={[head.x, head.y - 6, head.x, head.y + 6]} stroke="#3ddc84" strokeWidth={1} strokeScaleEnabled={false} listening={false} />
            </>
          )}
          <Transformer
            ref={trRef}
            rotateEnabled
            anchorSize={9}
            borderStroke="#ff6a2b"
            anchorStroke="#ff6a2b"
            anchorFill={P.anchor}
            keepRatio={false}
            ignoreStroke
            boundBoxFunc={(o, n) => (n.width < 2 || n.height < 2 ? o : n)}
          />
        </Layer>
      </Stage>
      </div>
      {camOpen && <CameraDialog onClose={() => setCamOpen(false)} />}
      <div className="canvas-hud">
        <button onClick={() => (camera.corners ? useStore.getState().setCamera({ on: !camera.on }) : setCamOpen(true))} title="Camera overlay on/off" className={camShown ? 'on' : ''}>📷</button>
        {camShown && <input type="range" min={0.1} max={1} step={0.05} value={camera.opacity} title="Camera opacity" onChange={(e) => useStore.getState().setCamera({ opacity: Number(e.target.value) })} style={{ width: 70 }} />}
        <button onClick={() => setCamOpen(true)} title="Set up the camera" style={{ display: camera.corners || camOpen ? undefined : 'none' }}>⚙</button>
        <button onClick={() => ((touched.current = false), fit())} title="Fit bed to view">Fit</button>
        <button onClick={() => ((touched.current = true), setView((v) => ({ ...v, k: v.k * 1.25 })))}>+</button>
        <button onClick={() => ((touched.current = true), setView((v) => ({ ...v, k: v.k / 1.25 })))}>−</button>
        <span>{machine.bedWidth} × {machine.bedHeight} mm</span>
      </div>
    </div>
  )
}
