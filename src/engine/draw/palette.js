/**
 * Single source of colour truth, consumed by both the canvas renderer and the
 * React shell so the panel chrome and the simulation always agree.
 */
export const palette = {
  background: '#070b14',
  panel: '#0b1220',
  panelAlt: '#101a2c',
  border: '#1d2c45',
  borderStrong: '#2b3f61',
  text: '#dbeafe',
  textDim: '#8ba3c7',
  accent: '#38bdf8',
  accentSoft: 'rgba(56,189,248,0.14)',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
  water: '#38bdf8',
  signal: '#4ade80',
}

export const lampColors = {
  amber: '#fde047',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa',
}

/** Stable per-port-kind colours used by the wiring UI and the oscilloscope. */
export const portColors = {
  digital: '#4ade80',
  analog: '#38bdf8',
  text: '#c084fc',
}

export const groupColors = {
  Sensors: '#38bdf8',
  Logic: '#a78bfa',
  Actuators: '#fbbf24',
  Fluid: '#22d3ee',
  Output: '#67e8f9',
  Input: '#c4b5fd',
  Structure: '#94a3b8',
  Misc: '#94a3b8',
}
