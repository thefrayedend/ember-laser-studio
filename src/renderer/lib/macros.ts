export interface Macro {
  id: string
  name: string
  /** One G-code or $ command per line. Lines starting with ; or ( are ignored. */
  code: string
}

const KEY = 'ember.macros.v1'

export const DEFAULT_MACROS: Macro[] = [
  { id: 'm_home', name: 'Home', code: '$H' },
  { id: 'm_unlock', name: 'Unlock', code: '$X' },
  { id: 'm_park', name: 'Park at front', code: 'G90\nG0 X0 Y0' },
  { id: 'm_air', name: 'Air assist on', code: 'M8' },
  { id: 'm_airoff', name: 'Air assist off', code: 'M9' },
]

export function loadMacros(): Macro[] {
  try {
    const t = localStorage.getItem(KEY)
    if (t) {
      const v = JSON.parse(t)
      if (Array.isArray(v)) return v as Macro[]
    }
  } catch {
    /* storage unavailable: use defaults */
  }
  return DEFAULT_MACROS
}

export function saveMacros(m: Macro[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* ignore */
  }
}

export const macroLines = (code: string) =>
  code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.startsWith('('))
