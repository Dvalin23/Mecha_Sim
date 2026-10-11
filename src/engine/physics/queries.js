import { Vec2 } from '../math/Vec2.js'
import { AABB } from './shapes.js'

/**
 * Geometric queries that the mechatronics layer depends on:
 * raycasting (ultrasonic ranging), point/AABB picking (editor + LCD), and
 * cone-of-vision tests (PIR motion sensor).
 *
 * The ray march reuses the spatial hash's DDA cell walk, so a ray only tests
 * bodies whose cells it actually enters — cost scales with ray length, not with
 * the number of bodies in the scene.
 */

/** Ray vs circle: quadratic |o + t·d − c|² = r². */
function raycastCircle(body, ox, oy, dx, dy, maxDistance) {
  const cx = body.position.x - ox
  const cy = body.position.y - oy
  const r = body.shape.radius
  // Project the centre onto the ray and solve for the chord half-length.
  const t = cx * dx + cy * dy
  const distSqCentre = cx * cx + cy * cy
  const halfChordSq = r * r - (distSqCentre - t * t)
  if (halfChordSq < 0) return null
  const halfChord = Math.sqrt(halfChordSq)
  let hit = t - halfChord
  if (hit < 0) hit = t + halfChord
  if (hit < 0 || hit > maxDistance) return null
  const px = ox + dx * hit
  const py = oy + dy * hit
  const nx = (px - body.position.x) / r
  const ny = (py - body.position.y) / r
  return { distance: hit, point: new Vec2(px, py), normal: new Vec2(nx, ny) }
}

/** Ray vs convex polygon: slab clipping (Cyrus–Beck) against every face plane. */
function raycastPolygon(body, ox, oy, dx, dy, maxDistance) {
  const shape = body.shape
  let tMin = 0
  let tMax = maxDistance
  let hitNormal = null

  for (let i = 0; i < shape.vertices.length; i++) {
    const n = shape.worldNormal(i, body.angle)
    const v = shape.worldVertex(i, body.position, body.angle)
    const denominator = n.dot({ x: dx, y: dy })
    const distance = n.dot({ x: v.x - ox, y: v.y - oy })
    if (Math.abs(denominator) < 1e-9) {
      // Ray parallel to this face: outside the slab means no intersection.
      if (distance > 0) return null
      continue
    }
    const t = distance / denominator
    if (denominator < 0) {
      if (t > tMin) {
        tMin = t
        hitNormal = n
      }
    } else if (t < tMax) {
      tMax = t
    }
    if (tMin > tMax) return null
  }

  if (!hitNormal || tMin < 0 || tMin > maxDistance) return null
  return {
    distance: tMin,
    point: new Vec2(ox + dx * tMin, oy + dy * tMin),
    normal: hitNormal.clone(),
  }
}

/**
 * Cast a ray through the world.
 *
 * @param {World} world
 * @param {Vec2} origin
 * @param {number} angle      direction, radians
 * @param {number} maxDistance
 * @param {object} [options]  { ignore:Set<uid>, tag:string, mask:number, hitFluid:boolean }
 * @returns {{body, point, normal, distance, fraction}|null}
 */
export function raycast(world, origin, angle, maxDistance, options = {}) {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const ignore = options.ignore ?? null
  const ignored = options.ignoreIds ?? null
  let closest = null
  const hash = world.spatialHash
  const hitFluid = options.hitFluid === true
  const mask = options.mask ?? 0b1111
  const layerFilter = options.layer ?? null

  for (const cell of hash.rayCells(origin.x, origin.y, dx, dy, maxDistance)) {
    if (cell.enterDistance > (closest ? closest.distance : maxDistance)) break
    const bucket = hash.cells.get(hash.constructor.key(cell.cx, cell.cy))
    if (!bucket) continue
    for (const body of bucket) {
      if (!body.enabled || body.removed || body.isFluid !== hitFluid) continue
      if (ignore && (ignore.has(body.uid) || (body.userData && ignore.has(body.userData.id)))) continue
      if (ignored && ignored.has(body.id)) continue
      if ((body.layer & mask) === 0) continue
      if (layerFilter !== null && body.layer !== layerFilter) continue
      const hit =
        body.shape.type === 'circle'
          ? raycastCircle(body, origin.x, origin.y, dx, dy, closest ? closest.distance : maxDistance)
          : raycastPolygon(body, origin.x, origin.y, dx, dy, closest ? closest.distance : maxDistance)
      if (hit && (!closest || hit.distance < closest.distance)) {
        closest = { body, ...hit }
      }
    }
    // Oversized "global" bodies are bucketed in the (-1,-1) cell; they are also
    // registered in the hash under that key, so we check it once per ray.
  }

  // Global-bucket bodies (level geometry larger than a few cells).
  const globalBucket = hash.cells.get(hash.constructor.key(-1, -1))
  if (globalBucket) {
    for (const body of globalBucket) {
      if (!body.enabled || body.removed || body.isFluid !== hitFluid) continue
      if (ignore && (ignore.has(body.uid) || (body.userData && ignore.has(body.userData.id)))) continue
      if (ignored && ignored.has(body.id)) continue
      if ((body.layer & mask) === 0) continue
      const hit =
        body.shape.type === 'circle'
          ? raycastCircle(body, origin.x, origin.y, dx, dy, closest ? closest.distance : maxDistance)
          : raycastPolygon(body, origin.x, origin.y, dx, dy, closest ? closest.distance : maxDistance)
      if (hit && (!closest || hit.distance < closest.distance)) closest = { body, ...hit }
    }
  }

  if (!closest) return null
  closest.fraction = closest.distance / maxDistance
  return closest
}

/** Every body whose shape contains the given world point (topmost last). */
export function pickPoint(world, x, y, options = {}) {
  const candidates = world.spatialHash.queryPoint(x, y, [])
  const hits = []
  for (const body of candidates) {
    if (!body.enabled || body.removed) continue
    if (options.includeFluid !== true && body.isFluid) continue
    if (body.containsPoint({ x, y })) hits.push(body)
  }
  return hits
}

/** AABB overlap query with shape-accurate filtering. */
export function queryRegion(world, aabb, options = {}) {
  const out = []
  const candidates = world.spatialHash.queryAABB(aabb, [])
  for (const body of candidates) {
    if (!body.enabled || body.removed) continue
    if (options.tag && body.tag !== options.tag) continue
    out.push(body)
  }
  return out
}

/** World-space AABB of a rotated box, used by the sensor cones. */
export function aabbOfCone(origin, angle, halfAngle, range) {
  const box = new AABB()
  box.expandToPoint(origin.x, origin.y)
  box.expandToPoint(origin.x + Math.cos(angle - halfAngle) * range, origin.y + Math.sin(angle - halfAngle) * range)
  box.expandToPoint(origin.x + Math.cos(angle + halfAngle) * range, origin.y + Math.sin(angle + halfAngle) * range)
  return box
}

/**
 * Point-in-triangle (barycentric sign test) with CCW/CW agnostic winding.
 */
export function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * PIR cone query: returns the visible entities inside the triangular field of
 * view, optionally requiring line-of-sight (walls occlude the sensor, which is
 * what makes the "hide behind the wall" puzzle solvable).
 */
export function queryCone(world, origin, angle, halfAngle, range, options = {}) {
  const box = aabbOfCone(origin, angle, halfAngle, range)
  const results = []
  const x1 = origin.x + Math.cos(angle - halfAngle) * range
  const y1 = origin.y + Math.sin(angle - halfAngle) * range
  const x2 = origin.x + Math.cos(angle + halfAngle) * range
  const y2 = origin.y + Math.sin(angle + halfAngle) * range

  const ignored = options.ignoreBodies ?? null
  for (const body of world.spatialHash.queryAABB(box, [])) {
    if (!body.enabled || body.removed) continue
    if (body.isFluid && options.includeFluid !== true) continue
    if (options.tag && body.tag !== options.tag) continue
    if (ignored && ignored.includes(body)) continue
    const dx = body.position.x - origin.x
    const dy = body.position.y - origin.y
    const distance = Math.hypot(dx, dy)
    if (distance > range) continue
    if (!pointInTriangle(body.position.x, body.position.y, origin.x, origin.y, x1, y1, x2, y2)) continue

    let visible = true
    if (options.lineOfSight) {
      const hit = raycast(world, origin, Math.atan2(dy, dx), distance - 2, {
        mask: options.mask ?? 0b1111,
        layer: options.occluderLayer ?? null,
      })
      visible = !hit || hit.body === body
    }
    if (!visible) continue
    results.push({ body, distance, angle: Math.atan2(dy, dx) })
  }
  results.sort((a, b) => a.distance - b.distance)
  return results
}

export { raycastCircle, raycastPolygon }
