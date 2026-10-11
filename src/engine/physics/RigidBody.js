import { Vec2 } from '../math/Vec2.js'
import { AABB, boxShape } from './shapes.js'
import { uuid } from '../ids.js'
import { clamp } from '../math/utils.js'

export const BodyType = Object.freeze({
  STATIC: 'static',
  KINEMATIC: 'kinematic',
  DYNAMIC: 'dynamic',
})

/** Collision masks. Anything sharing a bit can collide. */
export const Layer = Object.freeze({
  DEFAULT: 0b1,
  TERRAIN: 0b10,
  FLUID: 0b100,
  SENSOR_ONLY: 0b1000,
})

/**
 * The single moving/physical primitive of the simulator.
 *
 * Integrator: **semi-implicit (symplectic) Euler**.
 *
 *   v_{t+1} = v_t + (F_net / m) · Δt
 *   p_{t+1} = p_t + v_{t+1} · Δt
 *
 * Velocity is updated before position, so the new velocity *immediately* drives
 * the new position. That ordering is what keeps oscillating systems (springs,
 * stacked crates, bouncing fluid) from gaining energy the way explicit Euler
 * does. All units are SI with a pixels-per-metre scale applied by the renderer:
 * distances in px, masses in kg, forces in N, time in seconds.
 */
export class RigidBody {
  static _uidCounter = 1

  constructor(options = {}) {
    const {
      id = uuid(),
      shape = boxShape(40, 40),
      position = new Vec2(0, 0),
      angle = 0,
      bodyType = BodyType.DYNAMIC,
      mass = 1,
      density = null,
      restitution = 0.15,
      friction = 0.45,
      linearDamping = 0.02,
      angularDamping = 0.08,
      gravityScale = 1,
      fixedRotation = false,
      isFluid = false,
      layer = Layer.DEFAULT,
      mask = 0b1111,
      continuous = false,
      allowSleep = true,
      quadraticDrag = 0,
      tag = 'body',
      userData = null,
    } = options

    /** Monotonic integer id — used for O(1) pair keys in the broad phase. */
    this.uid = RigidBody._uidCounter++

    this.id = id
    this.tag = tag
    this.shape = shape

    this.position = new Vec2(position.x, position.y)
    this.angle = angle
    this.velocity = new Vec2(0, 0)
    this.angularVelocity = 0

    /** Previous transform, kept for render interpolation (alpha blending). */
    this.prevPosition = new Vec2(position.x, position.y)
    this.prevAngle = angle

    this.force = new Vec2(0, 0)
    this.torque = 0

    this.bodyType = bodyType
    this.restitution = restitution
    this.friction = friction
    this.linearDamping = linearDamping
    this.angularDamping = angularDamping
    this.gravityScale = gravityScale
    this.fixedRotation = fixedRotation
    this.isFluid = isFluid
    this.layer = layer
    this.mask = mask
    this.continuous = continuous
    this.allowSleep = allowSleep && bodyType === BodyType.DYNAMIC
    /** Quadratic (aerodynamic) drag coefficient: F = −k·|v|·v. Self-limiting,
     *  which is what keeps fast fluid from snowballing under a pump's draft. */
    this.quadraticDrag = quadraticDrag

    this.awake = true
    this.sleepTimer = 0
    this.enabled = true
    this.removed = false

    /** Optional back-reference to the mechatronic component that owns it. */
    this.userData = userData

    this.aabb = new AABB()
    this.computeMassFrom(density ?? mass)
    this.syncTransform(true)
  }

  // --- derived mass properties -------------------------------------------
  computeMassFrom(massOrDensity) {
    if (this.bodyType !== BodyType.DYNAMIC) {
      this.mass = 0
      this.invMass = 0
      this.inertia = 0
      this.invInertia = 0
      return
    }
    let mass = massOrDensity
    if (this.densityMode) mass = this.shape.area * massOrDensity
    this.mass = Math.max(mass, 1e-4)
    this.invMass = 1 / this.mass
    this.inertia = Math.max(this.shape.computeMass(this.mass), 1e-4)
    this.invInertia = this.fixedRotation ? 0 : 1 / this.inertia
  }

  setMass(mass) {
    this.densityMode = false
    const scale = this.mass > 0 ? Math.max(mass, 1e-4) / this.mass : 1
    this.computeMassFrom(Math.max(mass, 1e-4))
    // Keep the linear momentum consistent when mass changes mid-flight.
    this.velocity.scale(scale)
    return this
  }

  setShape(shape) {
    const wasStatic = this.bodyType !== BodyType.DYNAMIC
    this.shape = shape
    if (!wasStatic) {
      const mass = this.mass
      this.computeMassFrom(mass)
    }
    this.syncTransform(true)
    return this
  }

  setBodyType(type) {
    this.bodyType = type
    if (type === BodyType.DYNAMIC) {
      this.computeMassFrom(Math.max(this.mass, 0.1))
    } else {
      this.mass = 0
      this.invMass = 0
      this.inertia = 0
      this.invInertia = 0
      this.force.set(0, 0)
      this.torque = 0
      if (type === BodyType.STATIC) this.velocity.set(0, 0)
      this.angularVelocity = type === BodyType.STATIC ? 0 : this.angularVelocity
    }
    this.wake()
    return this
  }

  get isStatic() {
    return this.bodyType === BodyType.STATIC
  }

  get isDynamic() {
    return this.bodyType === BodyType.DYNAMIC
  }

  get speed() {
    return this.velocity.length()
  }

  // --- force application --------------------------------------------------
  /** Accumulate a world-space force, optionally at a world-space point (→ torque). */
  applyForce(force, worldPoint = null) {
    if (!this.isDynamic) return this
    if (this.awake) {
      this.force.add(force)
      if (worldPoint) {
        const r = Vec2.sub(worldPoint, this.position)
        this.torque += r.cross(force)
      }
    }
    return this
  }

  applyTorque(torque) {
    if (this.isDynamic && this.awake) this.torque += torque
    return this
  }

  /** Instantaneous velocity change. Used by the contact solver and joints. */
  applyImpulse(impulse, worldPoint = null) {
    if (!this.isDynamic) return this
    this.velocity.addScaled(impulse, this.invMass)
    if (worldPoint && this.invInertia !== 0) {
      const r = Vec2.sub(worldPoint, this.position)
      this.angularVelocity += this.invInertia * r.cross(impulse)
    }
    this.wake()
    return this
  }

  applyAngularImpulse(impulse) {
    if (this.isDynamic && this.invInertia !== 0) {
      this.angularVelocity += this.invInertia * impulse
      this.wake()
    }
    return this
  }

  /** Velocity of a world-space point on the body: v + ω × r. */
  velocityAt(worldPoint) {
    const r = Vec2.sub(worldPoint, this.position)
    return new Vec2(
      this.velocity.x - this.angularVelocity * r.y,
      this.velocity.y + this.angularVelocity * r.x,
    )
  }

  /**
   * Impulse applied at a pre-computed lever arm `r` (contact point − centre of
   * mass). The solver already stores `r` per contact, so this variant skips the
   * subtraction and keeps the inner iteration allocation-free.
   */
  applyImpulseAtOffset(impulse, r) {
    if (this.invMass === 0) return
    this.velocity.x += impulse.x * this.invMass
    this.velocity.y += impulse.y * this.invMass
    if (this.invInertia !== 0) {
      this.angularVelocity += this.invInertia * r.cross(impulse)
    }
  }

  /** Velocity without allocation, written into `out`. */
  velocityAtInto(worldPoint, out) {
    const rx = worldPoint.x - this.position.x
    const ry = worldPoint.y - this.position.y
    return out.set(
      this.velocity.x - this.angularVelocity * ry,
      this.velocity.y + this.angularVelocity * rx,
    )
  }

  // --- integration --------------------------------------------------------
  /** Integrate velocity for one fixed timestep (before constraint solving). */
  integrateVelocity(dt, gravity) {
    if (!this.isDynamic || !this.awake) return
    // a = F_net / m, summed from actuators, springs and gravity.
    this.velocity.x += (this.force.x * this.invMass + gravity.x * this.gravityScale) * dt
    this.velocity.y += (this.force.y * this.invMass + gravity.y * this.gravityScale) * dt
    this.angularVelocity += this.torque * this.invInertia * dt

    if (this.quadraticDrag > 0) {
      const speed = this.velocity.length()
      if (speed > 1e-4) {
        const decel = this.quadraticDrag * speed * speed
        this.velocity.addScaled(this.velocity, -decel * dt / speed)
      }
    }

    // Exponential (exact) damping — frame-rate independent, unlike v *= 0.99.
    if (this.linearDamping > 0) {
      const damp = 1 / (1 + this.linearDamping * dt)
      this.velocity.scale(damp)
    }
    if (this.angularDamping > 0) {
      this.angularVelocity *= 1 / (1 + this.angularDamping * dt)
    }
  }

  /** Integrate position from the freshly solved velocity. */
  integratePosition(dt) {
    if (this.isStatic || !this.awake) {
      if (this.bodyType === BodyType.KINEMATIC) {
        this.position.addScaled(this.velocity, dt)
        this.angle += this.angularVelocity * dt
      }
      return
    }
    this.position.addScaled(this.velocity, dt)
    this.angle += this.angularVelocity * dt
  }

  clearForces() {
    this.force.set(0, 0)
    this.torque = 0
  }

  syncTransform(force = false) {
    if (force) {
      this.prevPosition.copy(this.position)
      this.prevAngle = this.angle
    }
    if (this.shape.type === 'circle') {
      const aabb = this.shape.computeAABB(this.position)
      this.aabb.copy(aabb)
    } else {
      const aabb = this.shape.computeAABB(this.position, this.angle)
      this.aabb.copy(aabb)
    }
    return this.aabb
  }

  /** Cache the current transform as "previous" — called once per fixed step. */
  cacheTransform() {
    this.prevPosition.copy(this.position)
    this.prevAngle = this.angle
  }

  // --- sleep management ---------------------------------------------------
  wake() {
    if (!this.allowSleep || this.awake) return
    this.awake = true
    this.sleepTimer = 0
  }

  updateSleep(dt, linearThreshold, angularThreshold) {
    if (!this.isDynamic || !this.allowSleep || !this.awake) return
    const slow =
      this.velocity.lengthSq() < linearThreshold * linearThreshold &&
      Math.abs(this.angularVelocity) < angularThreshold
    if (slow) {
      this.sleepTimer += dt
      if (this.sleepTimer > 0.6) {
        this.awake = false
        this.velocity.set(0, 0)
        this.angularVelocity = 0
      }
    } else {
      this.sleepTimer = 0
    }
  }

  // --- queries ------------------------------------------------------------
  containsPoint(point) {
    if (this.shape.type === 'circle') return this.shape.containsPoint(point, this.position)
    return this.shape.containsPoint(point, this.position, this.angle)
  }

  worldPoint(localPoint) {
    const c = Math.cos(this.angle)
    const s = Math.sin(this.angle)
    return new Vec2(
      this.position.x + localPoint.x * c - localPoint.y * s,
      this.position.y + localPoint.x * s + localPoint.y * c,
    )
  }

  localPoint(worldPoint) {
    const c = Math.cos(this.angle)
    const s = Math.sin(this.angle)
    const dx = worldPoint.x - this.position.x
    const dy = worldPoint.y - this.position.y
    return new Vec2(dx * c + dy * s, -dx * s + dy * c)
  }

  translate(dx, dy) {
    this.position.x += dx
    this.position.y += dy
    this.wake()
    this.syncTransform(true)
    return this
  }

  setPosition(x, y) {
    this.position.set(x, y)
    this.wake()
    this.syncTransform(true)
    return this
  }

  setAngle(angle) {
    this.angle = angle
    this.wake()
    this.syncTransform(true)
    return this
  }

  /** Clamp pathological velocities to keep the solver stable on big impacts. */
  clampVelocity(maxLinear = 4000, maxAngular = 60) {
    this.velocity.clampLength(maxLinear)
    this.angularVelocity = clamp(this.angularVelocity, -maxAngular, maxAngular)
  }

  /**
   * Continuous-collision *guard* (cheap CCD).
   *
   * A discrete solver misses collisions when a body travels further in one step
   * than the obstacles are thick. The worst offender is not free flight but
   * **extrusion**: a dense pile crushed by an actuator, where the solver ejects a
   * particle at thousands of px/s and it teleports straight through a wall.
   *
   * Rather than a full swept-shape pass, we bound every body's per-step travel to
   * its own size (with a floor of `minTravel` px so small particles keep their
   * energy):
   *
   *     v_max = max(boundingRadius · 1.5, minTravel) / Δt
   *
   * At 60 Hz a 5 px droplet caps at 720 px/s (12 px/step) — enough to be thrown
   * across the map, never enough to pass through a 28 px floor in one step.
   */
  clampTravelPerStep(dt, minTravel = 12) {
    const maxTravel = Math.max(this.shape.boundingRadius * 1.5, minTravel)
    const maxSpeed = maxTravel / dt
    const speedSq = this.velocity.lengthSq()
    if (speedSq > maxSpeed * maxSpeed) {
      this.velocity.scale(maxSpeed / Math.sqrt(speedSq))
    }
    return this
  }
}

export default RigidBody
