import { generate } from '../../core/gcode/generate'
import { parseGcode } from '../../core/gcode/preview'
import type { GenOptions, GenResult, LayerJob } from '../../core/types'

export interface PackedMoves {
  n: number
  /** x0,y0,x1,y1 per move */
  xy: Float32Array
  s: Uint16Array
  rapid: Uint8Array
  line: Uint32Array
  maxS: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null
  estimateSeconds: number
}

export type WorkerIn =
  | { id: number; type: 'generate'; jobs: LayerJob[]; opts: GenOptions }
  | { id: number; type: 'parse'; lines: string[] }

export type WorkerOut =
  | { id: number; ok: true; result?: GenResult; packed: PackedMoves }
  | { id: number; ok: false; error: string }

function pack(lines: string[]): PackedMoves {
  const p = parseGcode(lines)
  const n = p.moves.length
  const xy = new Float32Array(n * 4)
  const s = new Uint16Array(n)
  const rapid = new Uint8Array(n)
  const line = new Uint32Array(n)
  p.moves.forEach((m, i) => {
    xy[i * 4] = m.x0
    xy[i * 4 + 1] = m.y0
    xy[i * 4 + 2] = m.x1
    xy[i * 4 + 3] = m.y1
    s[i] = Math.min(65535, Math.round(m.s))
    rapid[i] = m.rapid ? 1 : 0
    line[i] = m.line
  })
  return { n, xy, s, rapid, line, maxS: p.maxS, bounds: p.bounds, estimateSeconds: p.estimateSeconds }
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data
  try {
    if (m.type === 'generate') {
      const result = generate(m.jobs, m.opts)
      const packed = pack(result.lines)
      ;(self as unknown as Worker).postMessage({ id: m.id, ok: true, result, packed } satisfies WorkerOut, [
        packed.xy.buffer,
        packed.s.buffer,
        packed.rapid.buffer,
        packed.line.buffer,
      ])
    } else {
      const packed = pack(m.lines)
      ;(self as unknown as Worker).postMessage({ id: m.id, ok: true, packed } satisfies WorkerOut, [
        packed.xy.buffer,
        packed.s.buffer,
        packed.rapid.buffer,
        packed.line.buffer,
      ])
    }
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (e as Error).message } satisfies WorkerOut)
  }
}
