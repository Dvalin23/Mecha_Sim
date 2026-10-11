import { Vec2 } from '../math/Vec2.js'
import { RigidBody, BodyType } from './RigidBody.js'
import { SpatialHash } from './SpatialHash.js'
import { collide, Manifold } from './collisions.js'
import { Arbiter } from './resolver.js'
import { pickPoint, queryCone, queryRegion, raycast } from './queries.js'
import { clamp } from '../math/utils.js'

export const DEFAULT_SOLVER_CONFIG = Object.freeze({
  iterations: 8,
  /** Fraction of the positional error removed per step (Baumgarte β). */
  biasFactor: 0.22,
  /** Cap on Baumgarte separation velocity, px/s — keeps deep overlaps from popping. */
  maxBiasVelocity: 600,
  /** Penetration tolerated before the solver pushes back (px). */
  allowedPenetration: 0.5,
  /** Approach speed below which collisions are inelastic (px/s). */
  restitutionThreshold: 48,
  warmStarting: true,
  /** Clamp per-step travel so a teleported body cannot tunnel out of the map. */
  maxLinearVelocity: 6000,
  maxAngularVelocity: 80,
  /** Floor for the per-step travel guard, in px (see clampTravelPerStep). */
  minTravelPerStep: 12,
  linearSleepTolerance: 3,
  angularSleepTolerance: 0.06,
})

/**
 * The physics world: the "model" half of the engine's model/view split.
 *
 * One call to {@link World.step} executes the canonical pipeline:
 *
 *   1. cache transforms            (for render interpolation)
 *   2. apply joint/actuator forces (Hooke springs, servo PD torque)
 *   3. integrate velocities        (semi-implicit Euler, a = F_net/m)
 *   4. broad phase                 (spatial hash → candidate pairs)
 *   5. narrow phase                (SAT/clipping → contact manifolds)
 *   6. prepare contacts, then N Gauss-Seidel iterations (sequential impulses)
 *   7. integrate positions         (p_{t+1} = p_t + v_{t+1}·Δt)
 *   8. clear forces, sleep management, rebuild AABBs & the spatial hash
 *
 * The world never touches the DOM or the canvas: it is byte-identical under
 * Node (unit tests, headless soak runs) and the browser.
 */
export class World {
  constructor(options = {}) {
    const {
      gravity = 981,
      fixedDt = 1 / 60,
      cellSize = 96,
      bounds = { width: 1600, height: 900 },
      solver = {},
    } = options

    this.gravity = new Vec2(0, gravity)
    this.fixedDt = fixedDt
    this.time = 0
    this.stepCount = 0
    this.bounds = bounds
    this.solverConfig = { ...DEFAULT_SOLVER_CONFIG, ...solver }

    this.bodies = []
    this.joints = []
    /** @type {Map<number, Arbiter>} persistent arbiters for warm starting */
    this.arbiters = new Map()
    this.spatialHash = new SpatialHash({ cellSize, bounds })

    this._manifold = new Manifold()
    this._pendingRemoval = []
    this._beginContactListeners = new Set()
    this._endContactListeners = new Set()
    this._touchingPairs = new Set()
    this._stamp = 1
    this._pairScratch = []

    this.stats = {
      bodies: 0,
      contacts: 0,
      candidatePairs: 0,
      solverMs: 0,
      physicsMs: 0,
      hashCells: 0,
      maxOccupancy: 0,
    }
  }

  // --- scene graph --------------------------------------------------------
  addBody(body) {
    if (!(body instanceof RigidBody)) {
      body = new RigidBody(body)
    }
    this.bodies.push(body)
    body.syncTransform(true)
    return body
  }

  removeBody(body) {
    if (body && !body.removed) {
      body.removed = true
      this._pendingRemoval.push(body)
    }
    return this
  }

  addJoint(joint) {
    this.joints.push(joint)
    return joint
  }

  removeJoint(joint) {
    const index = this.joints.indexOf(joint)
    if (index >= 0) this.joints.splice(index, 1)
    return this
  }

  onBeginContact(listener) {
    this._beginContactListeners.add(listener)
    return () => this._beginContactListeners.delete(listener)
  }

  onEndContact(listener) {
    this._endContactListeners.add(listener)
    return () => this._endContactListeners.delete(listener)
  }

  clear() {
    this.bodies.length = 0
    this.joints.length = 0
    this.arbiters.clear()
    this.spatialHash.clear()
    this._touchingPairs.clear()
    this.time = 0
    this.stepCount = 0
  }

  /** Total mass of every dynamic body — surfaced in the inspector HUD. */
  get totalMass() {
    let total = 0
    for (const body of this.bodies) total += body.mass
    return total
  }

  get dynamicBodyCount() {
    let n = 0
    for (const body of this.bodies) if (body.isDynamic) n++
    return n
  }

  // --- integration pipeline ----------------------------------------------
  /** Fixed-timestep advance. `dt` must be exactly `fixedDt` for determinism. */
  step(dt = this.fixedDt) {
    const t0 = performance.now()
    this.time += dt
    this.stepCount++
    const config = this.solverConfig
    const invDt = 1 / dt

    // 1) Snapshot transforms for interpolation + rebuild broad phase from the
    //    freshly synced AABBs (bodies may have been moved by the editor).
    for (const body of this.bodies) {
      if (body.removed) continue
      body.cacheTransform()
      body.syncTransform()
    }
    this.rebuildBroadPhase()

    // 2) Constraint forces (springs, motors, ropes) — accumulate into F_net.
    for (const joint of this.joints) {
      if (joint.enabled) joint.prepare()
    }

    // 3) Semi-implicit Euler: velocity first, from every accumulated force.
    for (const body of this.bodies) {
      if (body.removed) continue
      body.integrateVelocity(dt, this.gravity)
    }

    // 4/5) Broad + narrow phase → persistent arbiters.
    this._stamp++
    const touched = this._pairScratch
    touched.length = 0
    let contactCount = 0

    this.spatialHash.forEachPair((a, b) => {
      // Sleep propagation: an awake body touching a sleeping one wakes it.
      if (a.awake !== b.awake) {
        if (a.awake && b.allowSleep && b.isDynamic) b.wake()
        else if (b.awake && a.allowSleep && a.isDynamic) a.wake()
      }
      const manifold = collide(this._manifold, a, b)
      const key = pairKey(a, b)
      let arbiter = this.arbiters.get(key)
      if (manifold && manifold.contacts.length) {
        if (!arbiter) {
          arbiter = new Arbiter(a, b)
          this.arbiters.set(key, arbiter)
        }
        arbiter.a = a
        arbiter.b = b
        arbiter.update(manifold)
        arbiter.stamp = this._stamp
        touched.push(key, arbiter)
        contactCount += arbiter.contacts.length
        this.emitBeginContact(key, a, b)
      } else if (arbiter) {
        this.emitEndContact(key, a, b)
        this.arbiters.delete(key)
      }
    })

    // 6) Prepare + solve.
    const t1 = performance.now()
    const arbiters = []
    for (let i = 0; i < touched.length; i += 2) arbiters.push(touched[i + 1])
    for (const arbiter of arbiters) arbiter.preStep(invDt, config)
    for (let iteration = 0; iteration < config.iterations; iteration++) {
      for (const arbiter of arbiters) arbiter.applyImpulse()
    }
    this.stats.solverMs = performance.now() - t1

    // 7) Integrate positions from the solved velocities + 8) bookkeeping.
    for (const body of this.bodies) {
      if (body.removed) continue
      body.integratePosition(dt)
      // Order matters: clamp angular/absolute velocity first, then the
      // per-step travel guard that makes tunnelling through thin geometry
      // impossible (see RigidBody.clampTravelPerStep).
      body.clampVelocity(config.maxLinearVelocity, config.maxAngularVelocity)
      body.clampTravelPerStep(dt, config.minTravelPerStep)
      body.clearForces()
      body.updateSleep(dt, config.linearSleepTolerance, config.angularSleepTolerance)
      body.syncTransform()
    }

    // Retire bodies that were removed mid-step.
    if (this._pendingRemoval.length) {
      this.bodies = this.bodies.filter((b) => !b.removed)
      for (const body of this._pendingRemoval) {
        for (const [key, arbiter] of this.arbiters) {
          if (arbiter.a === body || arbiter.b === body) this.arbiters.delete(key)
        }
      }
      this._pendingRemoval.length = 0
    }

    // Drop stale arbiters (pairs that stopped overlapping).
    for (const [key, arbiter] of this.arbiters) {
      if (arbiter.stamp !== this._stamp) {
        this.emitEndContact(key, arbiter.a, arbiter.b)
        this.arbiters.delete(key)
      }
    }

    this.stats.bodies = this.bodies.length
    this.stats.contacts = contactCount
    this.stats.physicsMs = performance.now() - t0
    return this
  }

  rebuildBroadPhase() {
    this.spatialHash.clear()
    for (const body of this.bodies) {
      if (body.removed || !body.enabled) continue
      this.spatialHash.insert(body)
    }
  }

  emitBeginContact(key, a, b) {
    if (this._touchingPairs.has(key)) return
    this._touchingPairs.add(key)
    for (const listener of this._beginContactListeners) listener(a, b)
  }

  emitEndContact(key, a, b) {
    if (!this._touchingPairs.has(key)) return
    this._touchingPairs.delete(key)
    for (const listener of this._endContactListeners) listener(a, b)
  }

  // --- queries ------------------------------------------------------------
  raycast(origin, angle, maxDistance, options) {
    return raycast(this, origin, angle, maxDistance, options)
  }

  pick(x, y, options) {
    return pickPoint(this, x, y, options)
  }

  queryRegion(aabb, options) {
    return queryRegion(this, aabb, options)
  }

  queryCone(origin, angle, halfAngle, range, options) {
    return queryCone(this, origin, angle, halfAngle, range, options)
  }

  /** Resolve a UUID or a body reference to a body instance. */
  findBody(idOrBody) {
    if (!idOrBody) return null
    if (typeof idOrBody === 'object') return idOrBody
    return this.bodies.find((b) => b.id === idOrBody) || null
  }

  getStats() {
    const hash = this.spatialHash.getStats()
    return {
      ...this.stats,
      hashCells: hash.cells,
      maxOccupancy: hash.maxOccupancy,
      candidatePairs: hash.candidatePairs,
      broadPhaseMs: hash.broadPhaseMs,
      arbiters: this.arbiters.size,
      joints: this.joints.length,
      bodies: this.bodies.length,
      dynamicBodies: this.dynamicBodyCount,
      totalMass: this.totalMass,
      awake: this.bodies.reduce((n, b) => n + (b.awake ? 1 : 0), 0),
      fluidParticles: this.bodies.reduce((n, b) => n + (b.isFluid ? 1 : 0), 0),
      time: this.time,
    }
  }

  /** Wake everything (e.g. right after a deserialize or a parameter edit). */
  wakeAll() {
    for (const body of this.bodies) {
      body.awake = true
      body.sleepTimer = 0
    }
    return this
  }

  /** Apply an instantaneous radial impulse — used by explosions / fan blasts. */
  applyRadialImpulse(centre, radius, strength, options = {}) {
    const affected = this.spatialHash.queryAABB(
      { minX: centre.x - radius, minY: centre.y - radius, maxX: centre.x + radius, maxY: centre.y + radius },
      [],
    )
    for (const body of affected) {
      if (!body.isDynamic) continue
      if (options.tag && body.tag !== options.tag) continue
      const d = Vec2.sub(body.position, centre)
      const distance = d.length()
      if (distance > radius || distance < 1e-6) continue
      const falloff = 1 - distance / radius
      body.applyImpulse(d.scale((strength * falloff) / distance))
    }
    return this
  }

  /** Teleport-safe velocity clamp helper for tools (drag & throw). */
  setBodyVelocity(body, vx, vy, max = 3000) {
    if (!body || !body.isDynamic) return
    body.velocity.set(clamp(vx, -max, max), clamp(vy, -max, max))
    body.wake()
  }
}

/** Order-independent key for the persistent arbiter map. */
function pairKey(a, b) {
  const lo = a.uid < b.uid ? a.uid : b.uid
  const hi = a.uid < b.uid ? b.uid : a.uid
  return lo * 1048576 + hi
}

export { BodyType, Vec2 }
