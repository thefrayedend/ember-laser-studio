// Shared types for the Ember core engine. Pure TypeScript: no Node or DOM imports.

export interface Point {
  x: number
  y: number
}

export interface Polyline {
  points: Point[]
  closed: boolean
  /** Shapes with the same group id are filled together with the even-odd rule (so letters keep their holes). */
  group?: number
}

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 2D affine matrix [a, b, c, d, e, f]: X = a*x + c*y + e, Y = b*x + d*y + f */
export type Matrix = [number, number, number, number, number, number]

export type Corner = 'bl' | 'br' | 'tl' | 'tr'
export type Anchor = 'bl' | 'br' | 'tl' | 'tr' | 'center'

export interface MachineProfile {
  id: string
  name: string
  /** Work area in mm. */
  bedWidth: number
  bedHeight: number
  /** $30: S value that equals 100% power. */
  maxS: number
  /** Max cut/engrave speed in mm/s the machine is allowed to be asked for. */
  maxSpeed: number
  /** Rapid (G0) speed in mm/s, used for time estimates only. */
  rapidSpeed: number
  baud: number
  /** Where machine 0,0 sits when using "bed" origin mode. */
  originCorner: Corner
  /** True when firmware has $32=1. Non-laser-mode firmware needs explicit M5 between moves. */
  laserMode: boolean
}

export const FALCON2_22W: MachineProfile = {
  id: 'creality-falcon2-22w',
  name: 'Creality Falcon2 22W',
  bedWidth: 400,
  bedHeight: 415,
  maxS: 1000,
  maxSpeed: 400,
  rapidSpeed: 200,
  baud: 115200,
  originCorner: 'bl',
  laserMode: true,
}

export const FALCON2_12W: MachineProfile = {
  ...FALCON2_22W,
  id: 'creality-falcon2-12w',
  name: 'Creality Falcon2 12W',
}

export type OriginMode =
  | { mode: 'bed' }
  /** Work zero (G54) is placed at an anchor of the job bounds. The app sets it to the head position first. */
  | { mode: 'job'; anchor: Anchor }

export type DitherMode = 'threshold' | 'floyd' | 'atkinson' | 'bayer' | 'grayscale'

export interface LayerSettings {
  id: string
  name: string
  color: string
  visible: boolean
  /** When false the layer is shown but not output. */
  output: boolean
  /** line = trace outlines, fill = hatch-fill closed shapes. Images and text are always raster-engraved. */
  mode: 'line' | 'fill'
  /** mm/s */
  speed: number
  /** % of maxS */
  power: number
  /** % of maxS used for the lightest gray in grayscale mode */
  minPower: number
  passes: number
  /** mm between scan lines (fill and raster) */
  lineInterval: number
  /** degrees, hatch angle for fill mode */
  fillAngle: number
  dither: DitherMode
  /** 0..255 cut-off for threshold mode */
  threshold: number
  bidirectional: boolean
  /** mm of run-up/run-out beyond each raster row so the head is at speed when it burns */
  overscan: number
  airAssist: boolean
  /** Cut inner shapes before outer ones (holes before the outline). */
  innerFirst: boolean
}

export function defaultLayer(id: string, name: string, color: string): LayerSettings {
  return {
    id,
    name,
    color,
    visible: true,
    output: true,
    mode: 'line',
    speed: 20,
    power: 30,
    minPower: 0,
    passes: 1,
    lineInterval: 0.1,
    fillAngle: 0,
    dither: 'floyd',
    threshold: 128,
    bidirectional: true,
    overscan: 2,
    airAssist: false,
    innerFirst: true,
  }
}

export interface ImageAdjust {
  /** -100..100 */
  brightness: number
  /** -100..100 */
  contrast: number
  invert: boolean
}

/** A grayscale bitmap placed in the design. 0 = black (burns), 255 = white. Transparent pixels must already be white. */
export interface PlacedImage {
  width: number
  height: number
  gray: Uint8Array
  /** Size of the image in local mm. */
  widthMm: number
  heightMm: number
  /** Maps local mm (origin top-left of the image, y down) to design mm. */
  matrix: Matrix
  adjust?: ImageAdjust
}

/** Everything the G-code generator needs for one layer. All geometry is in design space: mm, origin top-left, y down. */
export interface LayerJob {
  settings: LayerSettings
  vectors: Polyline[]
  images: PlacedImage[]
}

export interface GenOptions {
  machine: MachineProfile
  origin: OriginMode
  /** Park the head back at work zero when finished. */
  returnToOrigin: boolean
  /** Constant power (M3) instead of dynamic power (M4). Dynamic is the right default for lasers. */
  constantPower: boolean
}

export interface GenResult {
  lines: string[]
  bounds: Rect | null
  /** Rough duration in seconds. */
  estimateSeconds: number
  warnings: string[]
}
