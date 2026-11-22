import type { LayerSettings } from './types'

export interface Note {
  level: 'warn' | 'info'
  text: string
}

const mmMin = (mmS: number) => Math.round(mmS * 60)

/**
 * A few plain-language checks on a job's layer settings. Deliberately short: only things that are likely to cause a
 * fire, a ruined piece or a surprise, at most three at a time, never blocking.
 */
export function sanityNotes(layers: LayerSettings[], o: { powerCap?: number; estimateSeconds?: number } = {}): Note[] {
  const notes: Note[] = []
  for (const l of layers) {
    const slow = mmMin(l.speed)
    const what = `${l.name}: ${l.power}% at ${slow} mm/min`
    if (l.speed <= 0) notes.push({ level: 'warn', text: `${l.name} has no speed set, so it can't run.` })
    else if (l.mode === 'line' && l.power >= 50 && slow < 80) notes.push({ level: 'warn', text: `${what} is very slow and hot. Wood can catch fire. Raise the speed or lower the power.` })
    else if (l.mode === 'fill' && l.power >= 60 && slow < 500) notes.push({ level: 'warn', text: `${what} over a filled area will char deeply and can flame up. Try a higher speed or lower power.` })
    if (l.mode === 'fill' && l.lineInterval > 0 && l.lineInterval < 0.04) notes.push({ level: 'warn', text: `${l.name}: lines ${l.lineInterval} mm apart overlap and over-burn. 0.06 mm or more is usually plenty.` })
    if (l.mode === 'fill' && l.lineInterval > 0.3) notes.push({ level: 'info', text: `${l.name}: lines ${l.lineInterval} mm apart will leave visible stripes.` })
    if (l.passes >= 8) notes.push({ level: 'info', text: `${l.name} runs ${l.passes} passes, so stay close and watch for flames.` })
    if (l.power <= 0) notes.push({ level: 'info', text: `${l.name} is at 0% power, so nothing will burn.` })
    if (o.powerCap && o.powerCap < 100 && l.power > o.powerCap) notes.push({ level: 'info', text: `The owner limits power to ${o.powerCap}%, so ${l.name} (${l.power}%) will run at ${o.powerCap}%.` })
  }
  if (o.estimateSeconds && o.estimateSeconds > 3 * 3600) notes.push({ level: 'info', text: `This is a long job: about ${(o.estimateSeconds / 3600).toFixed(1)} hours.` })
  notes.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1))
  return notes.slice(0, 3)
}

const NO_BURN = /\b(pvc|vinyl|polyvinyl|abs|fiberglass|carbon fib(?:er|re)|teflon|ptfe|leather(?:ette)?\s*(?:faux|synthetic)|faux leather|pleather)\b/i

/** A quiet one-liner for a material name that gives off toxic fumes, or null. */
export function materialCaution(name: string): string | null {
  const m = NO_BURN.exec(name)
  if (!m) return null
  return `${m[1].toUpperCase()} can give off toxic or corrosive fumes when burned. Most people don't laser it.`
}
