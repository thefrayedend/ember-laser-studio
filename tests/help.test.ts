import { describe, expect, it } from 'vitest'
import { HELP } from '../src/core/help'
import { TESTS } from '../src/core/test/suites'

describe('help', () => {
  it('has a topic for the basics and every material test is explained', () => {
    const ids = HELP.map((h) => h.id)
    for (const need of ['start', 'tests', 'rate', 'camera', 'box', 'update', 'safety']) expect(ids).toContain(need)
    const tests = HELP.find((h) => h.id === 'tests')!.body.toLowerCase()
    for (const t of TESTS) expect(tests).toContain(t.label.split(':')[0].split(' / ')[0].split(' on')[0].toLowerCase())
  })
})
