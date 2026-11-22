import type { LayerSettings } from './types'

export interface MaterialPreset {
  id: string
  name: string
  material: string
  operation: 'cut' | 'score' | 'engrave' | 'photo'
  /** mm */
  thickness?: number
  settings: Partial<Pick<LayerSettings, 'mode' | 'speed' | 'power' | 'minPower' | 'passes' | 'lineInterval' | 'dither' | 'fillAngle' | 'airAssist'>>
  note?: string
}

/**
 * STARTING POINTS for the Creality Falcon2 12W. Rows marked "Creality published" come from Creality's 12W parameter
 * sheet (their speeds are in mm/min; stored here as mm/s). Everything varies with material, focus and air
 * assist, so run the material test grid on a scrap before trusting any of these.
 */
export const BUILTIN_PRESETS: MaterialPreset[] = [
  { id: 'bass-eng', name: 'Basswood / linden 2mm: engrave', material: 'Basswood plywood', operation: 'engrave', thickness: 2, settings: { mode: 'fill', speed: 66.67, power: 40, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'walnut-eng', name: 'Walnut plywood 3mm: engrave', material: 'Walnut plywood', operation: 'engrave', thickness: 3, settings: { mode: 'fill', speed: 66.67, power: 35, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'rose-eng', name: 'Rosewood plywood 3mm: engrave', material: 'Rosewood plywood', operation: 'engrave', thickness: 3, settings: { mode: 'fill', speed: 66.67, power: 35, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'bamboo-eng', name: 'Bamboo 5mm: engrave', material: 'Bamboo', operation: 'engrave', thickness: 5, settings: { mode: 'fill', speed: 66.67, power: 40, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'kraft-eng', name: 'Kraft paper: engrave', material: 'Paper and card', operation: 'engrave', thickness: 0.15, settings: { mode: 'fill', speed: 66.67, power: 15, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'card-eng', name: 'Red card paper: engrave', material: 'Paper and card', operation: 'engrave', thickness: 0.2, settings: { mode: 'fill', speed: 66.67, power: 15, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'felt-eng', name: 'Red felt 0.8mm: engrave', material: 'Felt', operation: 'engrave', thickness: 0.8, settings: { mode: 'fill', speed: 66.67, power: 15, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'leather-eng', name: 'Brown leather 0.65mm: engrave', material: 'Leather', operation: 'engrave', thickness: 0.65, settings: { mode: 'fill', speed: 66.67, power: 20, lineInterval: 0.1 }, note: 'Creality published 12W value.' },
  { id: 'acrylic-black-eng', name: 'Black acrylic: engrave', material: 'Black acrylic', operation: 'engrave', thickness: 4.6, settings: { mode: 'fill', speed: 66.67, power: 50, lineInterval: 0.1 }, note: 'Creality published 12W value. Diode lasers cannot cut clear or light acrylic.' },
  { id: 'anod-eng', name: 'Anodized aluminium 3mm: engrave', material: 'Metal', operation: 'engrave', thickness: 3, settings: { mode: 'fill', speed: 4.17, power: 100, lineInterval: 0.1 }, note: 'Creality published 12W value. Removes dye only; does not cut metal.' },
  { id: 'steel-eng', name: 'Brushed stainless steel 2mm: mark', material: 'Metal', operation: 'engrave', thickness: 2, settings: { mode: 'fill', speed: 100, power: 80, lineInterval: 0.1 }, note: 'Creality published value (12W/22W pages). Focus matters a lot.' },
  { id: 'tile-eng', name: 'Tile painted black 6mm: engrave', material: 'Tile and slate', operation: 'engrave', thickness: 6, settings: { mode: 'fill', speed: 66.67, power: 50, lineInterval: 0.1 }, note: 'Creality lists 50% to 85%. Start low.' },
  { id: 'kraft-cut', name: 'Kraft paper 0.2mm: cut', material: 'Paper and card', operation: 'cut', thickness: 0.2, settings: { mode: 'line', speed: 66.67, power: 100 }, note: 'Creality published 12W value.' },
  { id: 'card-cut', name: 'Red card paper 0.2mm: cut', material: 'Paper and card', operation: 'cut', thickness: 0.2, settings: { mode: 'line', speed: 66.67, power: 100 }, note: 'Creality published 12W value.' },
  { id: 'felt-cut', name: 'Red felt 0.8mm: cut', material: 'Felt', operation: 'cut', thickness: 0.8, settings: { mode: 'line', speed: 63.33, power: 100 }, note: 'Creality published 12W value.' },
  { id: 'leather-cut', name: 'Brown leather 0.65mm: cut', material: 'Leather', operation: 'cut', thickness: 0.65, settings: { mode: 'line', speed: 33.33, power: 100 }, note: 'Creality published 12W value.' },
  { id: 'bamboo-cut', name: 'Bamboo 5mm: cut', material: 'Bamboo', operation: 'cut', thickness: 5, settings: { mode: 'line', speed: 3.33, power: 100, airAssist: true }, note: 'Creality published 12W value.' },
  { id: 'ply-cut', name: 'Plywood 3mm: cut', material: 'Basswood plywood', operation: 'cut', thickness: 3, settings: { mode: 'line', speed: 3.33, power: 100, passes: 3, airAssist: true }, note: 'Community starting point for 12W with air assist. Glue and wood vary: test first.' },
  { id: 'ply-score', name: 'Plywood: score line', material: 'Basswood plywood', operation: 'score', settings: { mode: 'line', speed: 50, power: 20 }, note: 'Starting point only. Test on scrap.' },
]

export function applyPreset(layer: LayerSettings, p: MaterialPreset): LayerSettings {
  return { ...layer, ...p.settings }
}
