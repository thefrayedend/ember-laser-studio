export type P2 = { x: number; y: number }

/** 3x3 homography (row-major, h[8] = 1) mapping each src point onto the matching dst point. */
export function quadToQuad(src: P2[], dst: P2[]): number[] {
  // Solve for h0..h7 in: x' = (h0 x + h1 y + h2)/(h6 x + h7 y + 1), y' = (h3 x + h4 y + h5)/(h6 x + h7 y + 1)
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('The four corners must form a proper quadrilateral.')
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1]
}

export function applyH(h: number[], p: P2): P2 {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

/** CSS matrix3d() argument string for transform-origin 0 0. */
export function cssMatrix3d(h: number[]): string {
  return `matrix3d(${[h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]].join(',')})`
}
