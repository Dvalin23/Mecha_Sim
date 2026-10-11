/**
 * Numeric helpers shared by the physics core, the mechatronics layer and the
 * renderer. Kept dependency-free so the engine can run in Node (tests, headless
 * soak runs) as well as in the browser.
 */

export const EPSILON = 1e-6
export const TAU = Math.PI * 2

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v)

export const lerp = (a, b, t) => a + (b - a) * t

export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a))

export const clamp01 = (v) => clamp(v, 0, 1)

export const smoothstep = (t) => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** Shortest signed angular difference (b - a) wrapped into (-π, π]. */
export const angleDelta = (a, b) => {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d <= -Math.PI) d += TAU
  return d
}

export const lerpAngle = (a, b, t) => a + angleDelta(a, b) * t

export const deg2rad = (deg) => (deg * Math.PI) / 180
export const rad2deg = (rad) => (rad * 180) / Math.PI

/**
 * Deterministic PRNG (mulberry32). Every simulation gets its own seeded stream
 * so sensor noise, contact jitter and fluid emission are reproducible — this is
 * what makes the serialized projects replayable.
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Internal-method normal pair, good enough for sensor noise. */
export function gaussian(rand = Math.random) {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
}

/** Time-constant exponential moving average — the discrete IIR low-pass filter. */
export function ema(previous, sample, alpha) {
  return previous + (sample - previous) * clamp01(alpha)
}

/** Maps a time constant (seconds) + dt to an EMA alpha. */
export const rcAlpha = (dt, tauSeconds) =>
  tauSeconds <= 0 ? 1 : 1 - Math.exp(-dt / tauSeconds)

export function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps
}

export function roundTo(v, decimals = 2) {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

export function mean(values) {
  if (!values.length) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1)
  return sorted[idx]
}

/** 1 → 0 → 1 smoothing used for hysteresis-free UI easing. */
export const pingPong = (t) => 1 - Math.abs(((t % 2) + 2) % 2 - 1)

/** Collision group bitmask helpers. */
export const hasFlag = (mask, flag) => (mask & flag) === flag

/** Deep clone for plain JSON-ish data (fallbacks for exotic runtimes). */
export function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}
