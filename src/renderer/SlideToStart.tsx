import { useRef, useState } from 'react'

/** A slider you drag all the way across to confirm. Hard to trigger by accident, nothing to remember. */
export function SlideToStart({ label, disabled, onDone }: { label: string; disabled?: boolean; onDone: () => void }) {
  const track = useRef<HTMLDivElement>(null)
  const [x, setX] = useState(0)
  const [drag, setDrag] = useState(false)
  const KNOB = 52
  const max = () => (track.current?.clientWidth ?? 300) - KNOB - 4

  const move = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    setX(Math.max(0, Math.min(max(), clientX - r.left - KNOB / 2)))
  }
  const end = () => {
    setDrag(false)
    if (x >= max() * 0.97) {
      setX(max())
      onDone()
      setTimeout(() => setX(0), 600)
    } else setX(0)
  }
  const pct = max() > 0 ? x / max() : 0
  return (
    <div
      ref={track}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => !disabled && e.key === 'ArrowRight' && (setX(max()), onDone(), setTimeout(() => setX(0), 600))}
      style={{ position: 'relative', height: 56, borderRadius: 28, background: disabled ? '#2a2d33' : `linear-gradient(90deg, #ff5a1f ${pct * 100}%, #2a2d33 ${pct * 100}%)`, userSelect: 'none', touchAction: 'none', opacity: disabled ? 0.5 : 1, flex: 1, minWidth: 220 }}
    >
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 600, letterSpacing: 0.3, opacity: 1 - pct, pointerEvents: 'none' }}>{label} ›››</div>
      <div
        onPointerDown={(e) => {
          if (disabled) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          setDrag(true)
        }}
        onPointerMove={(e) => drag && move(e.clientX)}
        onPointerUp={end}
        onPointerCancel={() => (setDrag(false), setX(0))}
        style={{ position: 'absolute', top: 2, left: 2 + x, width: KNOB, height: 52, borderRadius: 26, background: '#fff', color: '#ff5a1f', display: 'grid', placeItems: 'center', fontSize: 24, cursor: disabled ? 'default' : 'grab', transition: drag ? 'none' : 'left .2s' }}
      >
        🔥
      </div>
    </div>
  )
}
