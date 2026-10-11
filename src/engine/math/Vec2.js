/**
 * Vec2 — immutable-friendly 2D vector.
 *
 * Contract: every instance method mutates `this` and returns `this` so the
 * physics broad/narrow phase can chain without allocating. Use the static
 * helpers (`Vec2.add`, ...) when you must not clobber an operand.
 */
export class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  // --- mutation -----------------------------------------------------------
  set(x, y) {
    this.x = x
    this.y = y
    return this
  }

  copy(v) {
    this.x = v.x
    this.y = v.y
    return this
  }

  clone() {
    return new Vec2(this.x, this.y)
  }

  add(v) {
    this.x += v.x
    this.y += v.y
    return this
  }

  sub(v) {
    this.x -= v.x
    this.y -= v.y
    return this
  }

  scale(s) {
    this.x *= s
    this.y *= s
    return this
  }

  /** this += v * s — the workhorse of force accumulation and impulse integration. */
  addScaled(v, s) {
    this.x += v.x * s
    this.y += v.y * s
    return this
  }

  negate() {
    this.x = -this.x
    this.y = -this.y
    return this
  }

  /** Allocation-free negate into a scratch vector (solver hot path). */
  negatedInto(out) {
    return out.set(-this.x, -this.y)
  }

  normalize() {
    const len = Math.hypot(this.x, this.y)
    if (len > 1e-9) {
      this.x /= len
      this.y /= len
    } else {
      this.x = 0
      this.y = 0
    }
    return this
  }

  /** Rotate around the origin by `rad` radians. */
  rotate(rad) {
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const x = this.x
    this.x = x * c - this.y * s
    this.y = x * s + this.y * c
    return this
  }

  /** Rotate around an arbitrary pivot. */
  rotateAround(pivot, rad) {
    return this.sub(pivot).rotate(rad).add(pivot)
  }

  /** Project onto a unit axis: this = axis * dot(this, axis). */
  projectOnto(axis) {
    const d = this.dot(axis)
    this.x = axis.x * d
    this.y = axis.y * d
    return this
  }

  clampLength(max) {
    const len = Math.hypot(this.x, this.y)
    if (len > max && len > 1e-9) this.scale(max / len)
    return this
  }

  // --- queries ------------------------------------------------------------
  dot(v) {
    return this.x * v.x + this.y * v.y
  }

  /** 2D cross product: the z component of the 3D cross product. */
  cross(v) {
    return this.x * v.y - this.y * v.x
  }

  /** Perpendicular (90° CCW). */
  perp() {
    return new Vec2(-this.y, this.x)
  }

  length() {
    return Math.hypot(this.x, this.y)
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y)
  }

  distanceSq(v) {
    const dx = this.x - v.x
    const dy = this.y - v.y
    return dx * dx + dy * dy
  }

  angle() {
    return Math.atan2(this.y, this.x)
  }

  equals(v, eps = 1e-6) {
    return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps
  }

  isFinite() {
    return Number.isFinite(this.x) && Number.isFinite(this.y)
  }

  toArray() {
    return [this.x, this.y]
  }

  toString(digits = 2) {
    return `(${this.x.toFixed(digits)}, ${this.y.toFixed(digits)})`
  }

  // --- statics ------------------------------------------------------------
  static of(x = 0, y = 0) {
    return new Vec2(x, y)
  }

  static fromAngle(rad, magnitude = 1) {
    return new Vec2(Math.cos(rad) * magnitude, Math.sin(rad) * magnitude)
  }

  static add(a, b) {
    return new Vec2(a.x + b.x, a.y + b.y)
  }

  static sub(a, b) {
    return new Vec2(a.x - b.x, a.y - b.y)
  }

  static scale(v, s) {
    return new Vec2(v.x * s, v.y * s)
  }

  static dot(a, b) {
    return a.x * b.x + a.y * b.y
  }

  static cross(a, b) {
    return a.x * b.y - a.y * b.x
  }

  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  static lerp(a, b, t) {
    return new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  }

  static zero() {
    return new Vec2(0, 0)
  }
}

export default Vec2
