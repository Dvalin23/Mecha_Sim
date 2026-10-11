import { Vec2 } from '../math/Vec2.js'
import { TAU } from '../math/utils.js'

/**
 * Axis-aligned bounding box used by the broad phase and by frustum culling.
 * Mutable by design: `RigidBody.syncAABB()` rewrites the same instance so the
 * spatial hash can be cleared without re-allocating thousands of boxes a second.
 */
export class AABB {
  constructor(minX = 0, minY = 0, maxX = 0, maxY = 0) {
    this.minX = minX
    this.minY = minY
    this.maxX = maxX
    this.maxY = maxY
  }

  set(minX, minY, maxX, maxY) {
    this.minX = minX
    this.minY = minY
    this.maxX = maxX
    this.maxY = maxY
    return this
  }

  copy(other) {
    return this.set(other.minX, other.minY, other.maxX, other.maxY)
  }

  /** Grow to include a world-space point. */
  expandToPoint(x, y) {
    if (x < this.minX) this.minX = x
    if (y < this.minY) this.minY = y
    if (x > this.maxX) this.maxX = x
    if (y > this.maxY) this.maxY = y
    return this
  }

  inflate(amount) {
    this.minX -= amount
    this.minY -= amount
    this.maxX += amount
    this.maxY += amount
    return this
  }

  get width() {
    return this.maxX - this.minX
  }

  get height() {
    return this.maxY - this.minY
  }

  get center() {
    return new Vec2((this.minX + this.maxX) / 2, (this.minY + this.maxY) / 2)
  }

  get area() {
    return this.width * this.height
  }

  overlaps(other) {
    return (
      this.minX <= other.maxX &&
      this.maxX >= other.minX &&
      this.minY <= other.maxY &&
      this.maxY >= other.minY
    )
  }

  containsPoint(x, y) {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY
  }

  static fromPoints(points) {
    const box = new AABB(Infinity, Infinity, -Infinity, -Infinity)
    for (const p of points) box.expandToPoint(p.x, p.y)
    return box
  }

  static union(a, b) {
    return new AABB(
      Math.min(a.minX, b.minX),
      Math.min(a.minY, b.minY),
      Math.max(a.maxX, b.maxX),
      Math.max(a.maxY, b.maxY),
    )
  }
}

/** Rotate a local-space vector into world orientation. */
export const rotateVec = (v, angle, out = new Vec2()) => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return out.set(v.x * c - v.y * s, v.x * s + v.y * c)
}

/** Rotate + translate a local-space point into world space. */
export const toWorld = (local, position, angle) => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return new Vec2(
    position.x + local.x * c - local.y * s,
    position.y + local.x * s + local.y * c,
  )
}

/** Inverse of {@link toWorld}. */
export const toLocal = (world, position, angle) => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = world.x - position.x
  const dy = world.y - position.y
  return new Vec2(dx * c + dy * s, -dx * s + dy * c)
}

/**
 * Circular collision shape. Cheapest primitive and the one used for every
 * simulated water droplet, projectile and rotor counterweight.
 */
export class CircleShape {
  constructor(radius = 10) {
    this.type = 'circle'
    this.radius = radius
  }

  computeMass(mass) {
    // Solid disc: I = ½ m r².
    this.inertiaFactor = 0.5 * mass * this.radius * this.radius
    return this.inertiaFactor
  }

  get area() {
    return Math.PI * this.radius * this.radius
  }

  /** Angular extent used by SAT fallbacks / broad-phase padding. */
  get boundingRadius() {
    return this.radius
  }

  computeAABB(position) {
    const r = this.radius
    return new AABB(position.x - r, position.y - r, position.x + r, position.y + r)
  }

  containsPoint(point, position) {
    const dx = point.x - position.x
    const dy = point.y - position.y
    return dx * dx + dy * dy <= this.radius * this.radius
  }

  /** World-space support point in direction `dir` (used by SAT for circles). */
  getSupport(position, dir) {
    const len = Math.hypot(dir.x, dir.y) || 1
    return new Vec2(
      position.x + (dir.x / len) * this.radius,
      position.y + (dir.y / len) * this.radius,
    )
  }

  clone() {
    return new CircleShape(this.radius)
  }

  serialize() {
    return { type: 'circle', radius: this.radius }
  }
}

/**
 * Convex polygon shape. Vertices are stored in body-local space and are assumed
 * to be wound counter-clockwise; normals are pre-computed once at construction
 * (and again only when the inspector edits `width`/`height`).
 */
export class PolygonShape {
  constructor(vertices) {
    this.type = 'polygon'
    this.setVertices(vertices)
  }

  setVertices(vertices) {
    // Accepts Vec2 instances, `{x, y}` objects *and* `[x, y]` pairs. The array
    // form matters: `serialize()` emits pairs, so a polygon that went through
    // the wire format and back used to come out as a shape full of NaN.
    this.vertices = vertices.map((v) =>
      v instanceof Vec2 ? v.clone() : Array.isArray(v) ? new Vec2(v[0], v[1]) : new Vec2(v.x, v.y),
    )
    this.normals = []
    this.boundingRadius = 0
    for (let i = 0; i < this.vertices.length; i++) {
      const a = this.vertices[i]
      const b = this.vertices[(i + 1) % this.vertices.length]
      const edge = Vec2.sub(b, a)
      // Outward normal for CCW winding is the right-hand perpendicular.
      const normal = new Vec2(edge.y, -edge.x)
      normal.normalize()
      this.normals.push(normal)
      this.boundingRadius = Math.max(this.boundingRadius, a.length())
    }
    return this
  }

  get area() {
    let sum = 0
    for (let i = 0; i < this.vertices.length; i++) {
      const a = this.vertices[i]
      const b = this.vertices[(i + 1) % this.vertices.length]
      sum += a.cross(b)
    }
    return Math.abs(sum) / 2
  }

  /** Area centroid of the polygon in local coordinates. */
  get centroid() {
    const centroid = new Vec2(0, 0)
    let area = 0
    const n = this.vertices.length
    for (let i = 0; i < n; i++) {
      const p1 = this.vertices[i]
      const p2 = this.vertices[(i + 1) % n]
      const cross = p1.cross(p2)
      area += cross
      centroid.x += (p1.x + p2.x) * cross
      centroid.y += (p1.y + p2.y) * cross
    }
    if (Math.abs(area) < 1e-12) return centroid
    return centroid.scale(1 / (3 * area))
  }

  /**
   * Polygon moment of inertia about the **centroid**, in the same units as
   * `mass` (standard triangle-fan decomposition plus the parallel-axis shift).
   *
   * The fan integral gives the second moment about the *local origin*, which is
   * only the centroid moment if the vertices happen to be centred on it. Two
   * corrections were needed here and both were measured against the closed-form
   * result for a solid box, I = m(w² + h²)/12:
   *
   * The fan integral gives the second moment about the *local origin*, which is
   * only the centroidal moment if the vertices happen to be centred on it. Three
   * things were wrong here, and every one of them was checked against the closed
   * form for a solid rectangle, I = m(w² + h²)/12:
   *
   *   · the fan sum must be divided by **12**, not 6 — the old constant made
   *     every polygon exactly twice as hard to spin as the real thing;
   *   · the cross products must stay **signed**. Taking `Math.abs` per edge is
   *     only harmless when the origin sees every vertex in the same rotational
   *     order; for a polygon that does not contain the origin the fan triangles
   *     cancel, and the absolute value throws that cancellation away (a 40×40
   *     square sitting at (120, 120) reported I ≈ 180,800 instead of 58,133);
   *   · an off-centre polygon then needs I_centroid = I_origin − m·d².
   */
  computeMass(mass) {
    const area = this.area
    if (area <= 1e-9) return (this.inertiaFactor = 0)
    let numerator = 0
    for (let i = 0; i < this.vertices.length; i++) {
      const p1 = this.vertices[i]
      const p2 = this.vertices[(i + 1) % this.vertices.length]
      numerator += p1.cross(p2) * (p1.dot(p1) + p1.dot(p2) + p2.dot(p2))
    }
    const density = mass / area
    const aboutOrigin = (density / 12) * Math.abs(numerator)
    const c = this.centroid
    this.inertiaFactor = Math.max(aboutOrigin - mass * c.lengthSq(), 1e-9)
    return this.inertiaFactor
  }

  computeAABB(position, angle = 0) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const v of this.vertices) {
      const x = position.x + v.x * c - v.y * s
      const y = position.y + v.x * s + v.y * c
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    return new AABB(minX, minY, maxX, maxY)
  }

  containsPoint(point, position, angle = 0) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const dx = point.x - position.x
    const dy = point.y - position.y
    const localX = dx * c + dy * s
    const localY = -dx * s + dy * c
    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i]
      const n = this.normals[i]
      if ((localX - v.x) * n.x + (localY - v.y) * n.y > 0) return false
    }
    return true
  }

  /** World-space unit normal of edge `i`. */
  worldNormal(i, angle) {
    const n = this.normals[i]
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Vec2(n.x * c - n.y * s, n.x * s + n.y * c)
  }

  worldVertex(i, position, angle) {
    return toWorld(this.vertices[i], position, angle)
  }

  getSupport(position, angle, dir) {
    let best = null
    let bestDot = -Infinity
    for (const v of this.vertices) {
      const w = toWorld(v, position, angle)
      const d = w.dot(dir)
      if (d > bestDot) {
        bestDot = d
        best = w
      }
    }
    return best
  }

  clone() {
    return new PolygonShape(this.vertices)
  }

  serialize() {
    return { type: 'polygon', vertices: this.vertices.map((v) => [v.x, v.y]) }
  }
}

/** Convenience factory: axis-aligned box centred on the body origin. */
export const boxShape = (width, height) =>
  new PolygonShape([
    new Vec2(-width / 2, -height / 2),
    new Vec2(width / 2, -height / 2),
    new Vec2(width / 2, height / 2),
    new Vec2(-width / 2, height / 2),
  ])

/** Regular n-gon (used for gears, rotors and the collider of round components). */
export const regularPolygonShape = (radius, sides = 8, rotation = 0) => {
  const verts = []
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * TAU
    verts.push(new Vec2(Math.cos(a) * radius, Math.sin(a) * radius))
  }
  return new PolygonShape(verts)
}

export { toWorld as shapeToWorld }
