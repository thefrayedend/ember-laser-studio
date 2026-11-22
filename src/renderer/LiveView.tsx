import { useEffect, useRef } from 'react'
import { useStore } from './store'

/** Small picture of the running job: finished part bright, remaining part dim, head position as a dot. */
export function LiveView() {
  const gen = useStore((s) => s.gen)
  const job = useStore((s) => s.job)
  const status = useStore((s) => s.status)
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    if (!c || !gen || !job) return
    const W = c.clientWidth || 600
    const H = 260
    const dpr = window.devicePixelRatio || 1
    c.width = W * dpr
    c.height = H * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    const b = gen.packed.bounds
    if (!b) return
    const pad = 14
    const vw = Math.max(1, b.maxX - b.minX)
    const vh = Math.max(1, b.maxY - b.minY)
    const k = Math.min((W - pad * 2) / vw, (H - pad * 2) / vh)
    const ox = (W - vw * k) / 2 - b.minX * k
    const oy = (H + vh * k) / 2 + b.minY * k
    const X = (x: number) => ox + x * k
    const Y = (y: number) => oy - y * k
    const p = gen.packed
    const doneLine = (job.acked / Math.max(1, job.total)) * gen.lines.length
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(0.6, Math.min(2, 0.15 * k))
    for (const [done, color] of [[false, 'rgba(255,255,255,0.16)'], [true, '#ff9a4d']] as const) {
      ctx.strokeStyle = color
      ctx.beginPath()
      for (let i = 0; i < p.n; i++) {
        if (p.s[i] <= 0 || p.line[i] < doneLine !== done) continue
        ctx.moveTo(X(p.xy[i * 4]), Y(p.xy[i * 4 + 1]))
        ctx.lineTo(X(p.xy[i * 4 + 2]), Y(p.xy[i * 4 + 3]))
      }
      ctx.stroke()
    }
    if (status) {
      ctx.fillStyle = '#3ddc84'
      ctx.beginPath()
      ctx.arc(X(status.wpos.x), Y(status.wpos.y), 5, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [gen, job, status])

  if (!gen || !job || job.name === undefined || !gen.name || job.name !== gen.name) return null
  return <canvas ref={ref} style={{ width: '100%', height: 260, borderRadius: 8, background: '#101216' }} />
}
