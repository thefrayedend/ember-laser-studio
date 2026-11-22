// GRBL 1.1 protocol helpers: line parsing, error/alarm text, realtime command bytes.

export type MachineState =
  | 'Disconnected'
  | 'Idle'
  | 'Run'
  | 'Hold'
  | 'Jog'
  | 'Alarm'
  | 'Door'
  | 'Check'
  | 'Home'
  | 'Sleep'
  | 'Unknown'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface MachineStatus {
  state: MachineState
  subState?: number
  mpos: Vec3
  wpos: Vec3
  wco: Vec3
  feed: number
  spindle: number
  /** feed, rapid, spindle override percentages */
  overrides: { feed: number; rapid: number; spindle: number }
  /** free planner blocks and free rx bytes as reported by Bf: */
  buffer?: { planner: number; rx: number }
  pins?: string
}

export const RT = {
  STATUS: '?',
  HOLD: '!',
  RESUME: '~',
  RESET: '\x18',
  JOG_CANCEL: '\x85',
  FEED_RESET: '\x90',
  FEED_PLUS10: '\x91',
  FEED_MINUS10: '\x92',
  FEED_PLUS1: '\x93',
  FEED_MINUS1: '\x94',
  RAPID_100: '\x95',
  RAPID_50: '\x96',
  RAPID_25: '\x97',
  SPINDLE_RESET: '\x99',
  SPINDLE_PLUS10: '\x9a',
  SPINDLE_MINUS10: '\x9b',
  SPINDLE_PLUS1: '\x9c',
  SPINDLE_MINUS1: '\x9d',
} as const

export type GrblEvent =
  | { type: 'ok' }
  | { type: 'error'; code: number; message: string }
  | { type: 'alarm'; code: number; message: string }
  | { type: 'status'; status: Partial<MachineStatus> & { state: MachineState } }
  | { type: 'setting'; id: number; value: string }
  | { type: 'welcome'; version: string }
  | { type: 'message'; text: string }
  | { type: 'unknown'; text: string }

export const ERROR_TEXT: Record<number, string> = {
  1: 'G-code word was missing its letter or number.',
  2: 'A number could not be read (bad format).',
  3: 'Unknown $ command.',
  4: 'Negative value where only positive is allowed.',
  5: 'Homing is not enabled in settings ($22).',
  6: 'Step pulse time too short ($0).',
  7: 'EEPROM read failed. Defaults restored.',
  8: 'That command only works while the machine is idle.',
  9: 'G-code is locked out during alarm or jog. Use Unlock or Home.',
  10: 'Soft limits need homing enabled first.',
  11: 'Line is too long for GRBL (max 80 characters).',
  12: 'Setting value exceeds the maximum step rate.',
  13: 'Safety door was opened.',
  14: 'Build info or startup line too long.',
  15: 'Jog target exceeds machine travel.',
  16: 'Jog command is missing "=" or has forbidden G-code.',
  17: 'Laser mode requires PWM output.',
  20: 'Unsupported or invalid G-code command.',
  21: 'More than one G-code command from the same modal group in one line.',
  22: 'Feed rate has not been set.',
  23: 'G-code command needs an integer value.',
  24: 'Two G-code commands both need axis words.',
  25: 'A G-code word was repeated in the line.',
  26: 'A G-code command is missing its required axis words.',
  27: 'Line number out of range.',
  28: 'A G-code command is missing a required value word.',
  29: 'G59.x work coordinate systems are not supported.',
  30: 'G53 only works with G0 and G1.',
  31: 'Axis words found but the command does not use them.',
  32: 'G2/G3 arcs need at least one axis word.',
  33: 'Motion target is invalid.',
  34: 'Arc radius is invalid.',
  35: 'G2/G3 arcs need at least one offset word.',
  36: 'Unused value words found in the block.',
  37: 'Tool length offset needs the Z axis.',
  38: 'Tool number too large.',
}

export const ALARM_TEXT: Record<number, string> = {
  1: 'Hard limit triggered. Position may be lost: re-home before continuing.',
  2: 'Soft limit alarm: the move would exceed machine travel.',
  3: 'Reset while the machine was moving. Position may be lost: re-home.',
  4: 'Probe fail.',
  5: 'Probe fail.',
  6: 'Homing failed: reset during the homing cycle.',
  7: 'Homing failed: safety door opened.',
  8: 'Homing failed: limit switch did not clear.',
  9: 'Homing failed: could not find the limit switch.',
  10: 'Homing failed: could not reach the limit switch.',
}

const vec = (s: string): Vec3 => {
  const [x, y, z] = s.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
}

export function parseGrblLine(raw: string): GrblEvent | null {
  const line = raw.trim()
  if (!line) return null
  if (line === 'ok') return { type: 'ok' }
  let m = /^error:(\d+)/i.exec(line)
  if (m) {
    const code = Number(m[1])
    return { type: 'error', code, message: ERROR_TEXT[code] ?? `GRBL error ${code}` }
  }
  m = /^ALARM:(\d+)/i.exec(line)
  if (m) {
    const code = Number(m[1])
    return { type: 'alarm', code, message: ALARM_TEXT[code] ?? `GRBL alarm ${code}` }
  }
  if (line.startsWith('<') && line.endsWith('>')) return parseStatus(line)
  m = /^\$(\d+)=(.*)$/.exec(line)
  if (m) return { type: 'setting', id: Number(m[1]), value: m[2].trim() }
  m = /^Grbl\s+(\S+)/i.exec(line)
  if (m) return { type: 'welcome', version: m[1] }
  if (line.startsWith('[') && line.endsWith(']')) return { type: 'message', text: line.slice(1, -1) }
  if (/^\[?MSG:/i.test(line)) return { type: 'message', text: line }
  return { type: 'unknown', text: line }
}

function parseStatus(line: string): GrblEvent {
  const parts = line.slice(1, -1).split('|')
  const [stateWord, sub] = parts[0].split(':')
  const known = ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep']
  const state = (known.includes(stateWord) ? stateWord : 'Unknown') as MachineState
  const status: Partial<MachineStatus> & { state: MachineState } = { state }
  if (sub !== undefined) status.subState = Number(sub)
  for (const p of parts.slice(1)) {
    const i = p.indexOf(':')
    if (i < 0) continue
    const key = p.slice(0, i)
    const val = p.slice(i + 1)
    switch (key) {
      case 'MPos':
        status.mpos = vec(val)
        break
      case 'WPos':
        status.wpos = vec(val)
        break
      case 'WCO':
        status.wco = vec(val)
        break
      case 'FS': {
        const [f, s] = val.split(',').map(Number)
        status.feed = f
        status.spindle = s
        break
      }
      case 'F':
        status.feed = Number(val)
        break
      case 'Ov': {
        const [feed, rapid, spindle] = val.split(',').map(Number)
        status.overrides = { feed, rapid, spindle }
        break
      }
      case 'Bf': {
        const [planner, rx] = val.split(',').map(Number)
        status.buffer = { planner, rx }
        break
      }
      case 'Pn':
        status.pins = val
        break
    }
  }
  return { type: 'status', status }
}

/** Strip comments and whitespace the way GRBL does, so we know the real line length. */
export function cleanGcodeLine(line: string): string {
  return line
    .replace(/\(.*?\)/g, '')
    .replace(/;.*$/, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}
