import { Vec2 } from '../math/Vec2.js'
import { toWorld } from './shapes.js'

/**
 * Narrow phase: exact intersection testing and contact generation.
 *
 * Two algorithms cooperate here:
 *
 *  1. **SAT (Separating Axis Theorem)** for polygon/polygon. If any axis exists
 *     on which the projections of the two convex sets do not overlap, the shapes
 *     are disjoint. For convex polygons it is sufficient to test the face
 *     normals of both bodies: 2·n axes instead of an infinite search. The axis
 *     of *least* penetration becomes the collision normal, and the face owning
 *     it becomes the "reference face".
 *
 *  2. **Clipping** to turn the 1-axis answer into real contact points. The
 *     incident face (the face of the other body most anti-parallel to the
 *     reference face) is clipped against the reference face's side planes,
 *     producing up to two contact points. Two points are what makes a box rest
 *     flat instead of rocking on a single corner.
 *
 * Every manifold normal points **from `manifold.a` to `manifold.b`**, which is
 * what the impulse solver in `resolver.js` assumes.
 */

let featureSerial = 0

export class ManifoldContact {
  constructor() {
    this.point = new Vec2()
    this.separation = 0
    this.featureId = 0
    // Solver scratch/state (persisted across frames for warm starting).
    this.normalImpulse = 0
    this.tangentImpulse = 0
    this.massNormal = 0
    this.massTangent = 0
    this.bias = 0
    this.restitutionBias = 0
    this.rA = new Vec2()
    this.rB = new Vec2()
  }
}

export class Manifold {
  constructor(a = null, b = null) {
    this.a = a
    this.b = b
    this.normal = new Vec2()
    this.contacts = []
    this.restitution = 0
    this.friction = 0
  }

  reset(a, b) {
    this.a = a
    this.b = b
    this.normal.set(0, 0)
    this.contacts.length = 0
    return this
  }

  addContact(point, separation, featureId) {
    let contact = this.contacts[this.contacts.length]
    if (!contact) {
      contact = new ManifoldContact()
      this.contacts.push(contact)
    }
    contact.point.copy(point)
    contact.separation = separation
    contact.featureId = featureId
    contact.normalImpulse = 0
    contact.tangentImpulse = 0
    return contact
  }

  get count() {
    return this.contacts.length
  }
}

/** Squared distance helper kept local so the hot path avoids Vec2 allocation. */
const distSq = (ax, ay, bx, by) => {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/**
 * Clips a 2-point segment against the half-space dot(n, p) <= c.
 * Returns `null` when the result degenerates to fewer than two points.
 */
function clipSegment(nx, ny, c, face) {
  const d1 = nx * face[0].x + ny * face[0].y - c
  const d2 = nx * face[1].x + ny * face[1].y - c
  const out = []
  if (d1 <= 0) out.push(face[0])
  if (d2 <= 0) out.push(face[1])
  if (d1 * d2 < 0) {
    const alpha = d1 / (d1 - d2)
    out.push(
      new Vec2(
        face[0].x + alpha * (face[1].x - face[0].x),
        face[0].y + alpha * (face[1].y - face[0].y),
      ),
    )
  }
  if (out.length < 2) return null
  return [out[0], out[1]]
}

/** SAT helper: least-penetrating face of `sa` against `sb`. Negative ⇒ overlap. */
function findAxisLeastPenetration(sa, bodyA, sb, bodyB) {
  let bestDistance = -Infinity
  let bestIndex = 0
  for (let i = 0; i < sa.vertices.length; i++) {
    const nw = sa.worldNormal(i, bodyA.angle)
    const support = sb.getSupport(bodyB.position, bodyB.angle, new Vec2(-nw.x, -nw.y))
    const v = sa.worldVertex(i, bodyA.position, bodyA.angle)
    const distance = nw.x * (support.x - v.x) + nw.y * (support.y - v.y)
    if (distance > bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }
  return { distance: bestDistance, index: bestIndex }
}

/** Index of the face on `shape` whose outward normal is most anti-parallel to ref. */
function findIncidentFace(shape, body, refNormal) {
  let bestIndex = 0
  let minDot = Infinity
  for (let i = 0; i < shape.vertices.length; i++) {
    const n = shape.worldNormal(i, body.angle)
    const d = n.dot(refNormal)
    if (d < minDot) {
      minDot = d
      bestIndex = i
    }
  }
  const count = shape.vertices.length
  return [
    shape.worldVertex(bestIndex, body.position, body.angle),
    shape.worldVertex((bestIndex + 1) % count, body.position, body.angle),
  ]
}

// --- polygonal pair -------------------------------------------------------

function collidePolygons(manifold, a, b) {
  const sa = a.shape
  const sb = b.shape

  const faceA = findAxisLeastPenetration(sa, a, sb, b)
  if (faceA.distance >= 0) return false // separating axis found on A's faces

  const faceB = findAxisLeastPenetration(sb, b, sa, a)
  if (faceB.distance >= 0) return false

  // Prefer A's face unless B's penetrates measurably less (bias avoids
  // flip-flopping between frames, which would churn contact warm-starting).
  const biasGreaterThan = (x, y) => x >= y * 0.95 + x * 0.01
  let refShape
  let refBody
  let incShape
  let incBody
  let refIndex
  let flip
  if (biasGreaterThan(faceA.distance, faceB.distance)) {
    refShape = sa
    refBody = a
    incShape = sb
    incBody = b
    refIndex = faceA.index
    flip = false
  } else {
    refShape = sb
    refBody = b
    incShape = sa
    incBody = a
    refIndex = faceB.index
    flip = true
  }

  const count = refShape.vertices.length
  const v1 = refShape.worldVertex(refIndex, refBody.position, refBody.angle)
  const v2 = refShape.worldVertex((refIndex + 1) % count, refBody.position, refBody.angle)
  const sidePlane = Vec2.sub(v2, v1)
  const sideLength = sidePlane.length()
  if (sideLength < 1e-9) return false
  sidePlane.scale(1 / sideLength)
  const refFaceNormal = new Vec2(sidePlane.y, -sidePlane.x) // outward normal, CCW winding

  const refC = refFaceNormal.dot(v1)
  const negSide = -sidePlane.dot(v1)
  const posSide = sidePlane.dot(v2)

  let incident = findIncidentFace(incShape, incBody, refFaceNormal)
  incident = clipSegment(-sidePlane.x, -sidePlane.y, negSide, incident)
  if (!incident) return false
  incident = clipSegment(sidePlane.x, sidePlane.y, posSide, incident)
  if (!incident) return false

  manifold.normal.copy(refFaceNormal)
  if (flip) manifold.normal.negate()

  // Keep only the points that are actually behind the reference face.
  for (let i = 0; i < 2; i++) {
    const separation = refFaceNormal.dot(incident[i]) - refC
    if (separation <= 0) {
      const featureId = ((flip ? 1 : 0) << 10) | (refIndex << 4) | (i & 0x3)
      manifold.addContact(incident[i].clone(), separation, featureId)
    }
  }
  return manifold.contacts.length > 0
}

// --- circular pairs -------------------------------------------------------

function collideCircles(manifold, a, b) {
  const rSum = a.shape.radius + b.shape.radius
  const dx = b.position.x - a.position.x
  const dy = b.position.y - a.position.y
  const distSqr = dx * dx + dy * dy
  if (distSqr > rSum * rSum) return false
  const distance = Math.sqrt(distSqr)
  if (distance < 1e-6) {
    manifold.normal.set(0, -1)
    manifold.addContact(new Vec2(a.position.x, a.position.y - a.shape.radius), -rSum, 0)
    return true
  }
  const nx = dx / distance
  const ny = dy / distance
  manifold.normal.set(nx, ny)
  const point = new Vec2(a.position.x + nx * a.shape.radius, a.position.y + ny * a.shape.radius)
  manifold.addContact(point, distance - rSum, 0)
  return true
}

/** circle (a) → polygon (b); the manifold normal points from a to b. */
function collideCirclePolygonOrdered(manifold, circle, circleBody, poly, polyBody) {
  const r = circle.radius
  const centre = circleBody.position
  let bestSeparation = -Infinity
  let bestFace = 0
  const count = poly.vertices.length
  for (let i = 0; i < count; i++) {
    const n = poly.worldNormal(i, polyBody.angle)
    const v1 = poly.worldVertex(i, polyBody.position, polyBody.angle)
    const separation = n.x * (centre.x - v1.x) + n.y * (centre.y - v1.y)
    if (separation > r) return false // an axis separates them entirely
    if (separation > bestSeparation) {
      bestSeparation = separation
      bestFace = i
    }
  }

  const n = poly.worldNormal(bestFace, polyBody.angle)
  const v1 = poly.worldVertex(bestFace, polyBody.position, polyBody.angle)
  const v2 = poly.worldVertex((bestFace + 1) % count, polyBody.position, polyBody.angle)

  // Vertex regions: clamp onto the closest endpoint.
  const dot1 = (centre.x - v1.x) * (v2.x - v1.x) + (centre.y - v1.y) * (v2.y - v1.y)
  const dot2 = (centre.x - v2.x) * (v1.x - v2.x) + (centre.y - v2.y) * (v1.y - v2.y)

  if (bestSeparation < 1e-6) {
    // Centre is inside the polygon — deep penetration, push out along the
    // least-penetrating face normal (negated: circle → polygon).
    //
    // The contact point must be the closest point on that face *segment*, not
    // the face's first vertex: a level wall is ~1600 px long, so a corner
    // contact would hand the solver a lever arm of hundreds of pixels. The
    // effective mass along the normal then collapses to ~1/(invI·r²) and the
    // body can no longer be extruded — it just sinks through the floor.
    const ex = v2.x - v1.x
    const ey = v2.y - v1.y
    const lenSq = ex * ex + ey * ey || 1
    let t = ((centre.x - v1.x) * ex + (centre.y - v1.y) * ey) / lenSq
    t = t < 0 ? 0 : t > 1 ? 1 : t
    manifold.normal.set(-n.x, -n.y)
    manifold.addContact(new Vec2(v1.x + ex * t, v1.y + ey * t), bestSeparation - r, 0)
    return true
  }

  if (dot1 <= 0) {
    if (distSq(centre.x, centre.y, v1.x, v1.y) > r * r) return false
    const d = Math.hypot(centre.x - v1.x, centre.y - v1.y) || 1
    manifold.normal.set(-(centre.x - v1.x) / d, -(centre.y - v1.y) / d)
    manifold.addContact(v1.clone(), d - r, 0)
    return true
  }

  if (dot2 <= 0) {
    if (distSq(centre.x, centre.y, v2.x, v2.y) > r * r) return false
    const d = Math.hypot(centre.x - v2.x, centre.y - v2.y) || 1
    manifold.normal.set(-(centre.x - v2.x) / d, -(centre.y - v2.y) / d)
    manifold.addContact(v2.clone(), d - r, 0)
    return true
  }

  manifold.normal.set(-n.x, -n.y)
  const point = new Vec2(centre.x - n.x * r, centre.y - n.y * r)
  manifold.addContact(point, bestSeparation - r, 0)
  return true
}

/** Flips a manifold produced for (a, b) so it reads as (b, a). */
function flipManifold(manifold, a, b) {
  const tmp = manifold.a
  manifold.a = manifold.b
  manifold.b = tmp
  manifold.normal.negate()
  return manifold
}

/**
 * Public entry point. `manifold` is a pooled instance owned by the world so a
 * steady-state simulation allocates nothing per frame.
 */
export function collide(manifold, a, b) {
  manifold.reset(a, b)
  const ta = a.shape.type
  const tb = b.shape.type
  let hit = false

  if (ta === 'circle' && tb === 'circle') {
    hit = collideCircles(manifold, a, b)
  } else if (ta === 'circle' && tb === 'polygon') {
    hit = collideCirclePolygonOrdered(manifold, a.shape, a, b.shape, b)
  } else if (ta === 'polygon' && tb === 'circle') {
    hit = collideCirclePolygonOrdered(manifold, b.shape, b, a.shape, a)
    if (hit) {
      flipManifold(manifold, a, b)
      manifold.a = a
      manifold.b = b
      // `collideCirclePolygonOrdered` oriented the normal circle→polygon, which
      // after the swap must read polygon→circle.
      // (flipManifold negates the normal for us.)
    }
  } else {
    hit = collidePolygons(manifold, a, b)
  }

  if (!hit) return null
  manifold.a = a
  manifold.b = b
  // Effective material constants: geometric mean keeps a rubber ball on steel
  // from behaving like either extreme.
  manifold.restitution = Math.min(a.restitution, b.restitution)
  manifold.friction = Math.sqrt(a.friction * b.friction)
  return manifold
}

export { toWorld }
