import { describe, expect, it } from 'vitest'
import { sanityNotes, materialCaution } from '../src/core/sanity'
import type { LayerSettings } from '../src/core/types'

const L = (o: Partial<LayerSettings>) => ({ id: 'a', name: 'Cut', mode: 'line', speed: 5, power: 100, passes: 1, lineInterval: 0.1, ...o }) as LayerSettings

describe('sanityNotes', () => {
  it('says nothing for normal settings', () => {
    expect(sanityNotes([L({ speed: 5 }), L({ mode: 'fill', speed: 66, power: 40 })], { estimateSeconds: 600 })).toEqual([])
  })
  it('warns about slow and hot, over-tight spacing and many passes, at most three, warnings first', () => {
    const n = sanityNotes([L({ speed: 1, power: 90, passes: 9 }), L({ name: 'E', mode: 'fill', lineInterval: 0.02, speed: 50, power: 20 })])
    expect(n.length).toBe(3)
    expect(n[0].level).toBe('warn')
    expect(n.map((x) => x.text).join(' ')).toMatch(/fire|slow/)
  })
  it('mentions the owner power cap and long jobs', () => {
    const n = sanityNotes([L({ speed: 5, power: 100 })], { powerCap: 60, estimateSeconds: 4 * 3600 })
    expect(n.map((x) => x.text).join(' ')).toMatch(/limits power to 60%/)
    expect(n.map((x) => x.text).join(' ')).toMatch(/4\.0 hours/)
  })
  it('flags a missing speed', () => {
    expect(sanityNotes([L({ speed: 0 })])[0].text).toMatch(/no speed/)
  })
})

describe('materialCaution', () => {
  it('only reacts to toxic-fume materials', () => {
    expect(materialCaution('3 mm birch ply')).toBeNull()
    expect(materialCaution('Black PVC sheet')).toMatch(/toxic/)
    expect(materialCaution('Acrylic')).toBeNull()
  })
})
