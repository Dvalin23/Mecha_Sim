import { Vec2 } from '../math/Vec2.js'
import { angleDelta, clamp } from '../math/utils.js'

/**
 * Constraints used by the mechatronics actuators.
 *
 * All joints are solved with the same impulse formulation as contacts (they are
 * simply *bilateral* constraints — impulses may pull as well as push) and are
 * applied positionally too, so a servo holding a rotor at 45° does not drift.
 */
export class Joint {
  constructor(a, b) {
    this.a = a
    this.b = b
    this.enabled = true
  }

  prepare() {}

  solveVelocity() {}

  solvePosition(/* dt */) {}
}

/**
 * MotorJoint — a virtual servo.
 *
 * Drives the relative angle between two bodies toward `targetAngle` with a
 * torque limited by `maxTorque`. The PD controller is
 *
 *   τ = k_p · Δθ − k_d · ω
 *
 * where Δθ is the shortest signed angular difference. This is exactly how the
 * pump impeller and the relay-driven conveyor are actuated: the microcontroller
 * writes a target angle / speed, the physics engine finds the torque.
 */
export class MotorJoint extends Joint {
  constructor(a, b, options = {}) {
    super(a, b)
    const {
      maxTorque = 4000,
      stiffness = 220,
      damping = 28,
      targetSpeed = null,
      targetAngle = null,
    } = options
    this.maxTorque = maxTorque
    this.stiffness = stiffness
    this.damping = damping
    this.targetSpeed = targetSpeed
    this.targetAngle = targetAngle
    this.enabledTorque = 0
    this.lastError = 0
  }

  prepare() {
    const { a, b } = this
    if (!a || !b || !this.enabled) return
    if (a.invInertia === 0 && b.invInertia === 0) return

    // Regulate speed directly when a target speed is set (velocity control),
    // otherwise regulate the angle (position control).
    const relativeSpeed = b.angularVelocity - a.angularVelocity
    if (this.targetSpeed !== null) {
      const error = this.targetSpeed - relativeSpeed
      this.lastError = error
      let torque = error * this.damping + error * this.stiffness * 0.05
      torque = clamp(torque, -this.maxTorque, this.maxTorque)
      this.enabledTorque = torque
    } else {
      const target = this.targetAngle ?? b.angle
      const error = angleDelta(b.angle - a.angle, target)
      this.lastError = error
      let torque = this.stiffness * error - this.damping * relativeSpeed
      torque = clamp(torque, -this.maxTorque, this.maxTorque)
      this.enabledTorque = torque
    }
    a.applyTorque(-this.enabledTorque)
    b.applyTorque(this.enabledTorque)
  }

  solveVelocity() {
    // PD torque is already a velocity-space command applied in `prepare`.
  }
}

/**
 * SpringJoint (a.k.a. distance constraint).
 *
 * Two bodies are tethered by a Hooke spring with damping:
 *
 *   F = −k·(|d| − restLength) · d̂ − c·(v_rel · d̂) · d̂
 *
 * Used by the vibration sensor's cantilever mass and by the "balloon" fixture
 * that snaps parts back onto a snapped grid.
 */
export class SpringJoint extends Joint {
  constructor(a, b, options = {}) {
    super(a, b)
    const { restLength = 60, stiffness = 60, damping = 1.2, anchorA = null, anchorB = null } = options
    this.restLength = restLength
    this.stiffness = stiffness
    this.damping = damping
    this.anchorA = anchorA ? anchorA.clone() : new Vec2(0, 0)
    this.anchorB = anchorB ? anchorB.clone() : new Vec2(0, 0)
  }

  prepare() {
    const { a, b } = this
    if (!a || !b || !this.enabled) return
    const pa = a.worldPoint ? a.worldPoint(this.anchorA) : a.position
    const pb = b.worldPoint ? b.worldPoint(this.anchorB) : b.position
    const d = Vec2.sub(pb, pa)
    const length = d.length()
    if (length < 1e-6) return
    d.scale(1 / length)

    const extension = length - this.restLength
    const va = a.velocityAt(pa)
    const vb = b.velocityAt(pb)
    const relSpeed = Vec2.sub(vb, va).dot(d)

    // F = −k·x − c·v̂  (Hooke's law, damped)
    const magnitude = -this.stiffness * extension - this.damping * relSpeed
    const force = d.scale(magnitude)
    a.applyForce(force.clone().negate(), pa)
    b.applyForce(force, pb)
  }
}

/**
 * FixedJoint — welds two bodies (used when parts are "bolted" together in the
 * editor and by the rotary encoder's detents).
 */
export class FixedJoint extends Joint {
  constructor(a, b, options = {}) {
    super(a, b)
    this.localAnchorA = options.anchorA ? options.anchorA.clone() : new Vec2(0, 0)
    this.localAnchorB = options.anchorB ? options.anchorB.clone() : new Vec2(0, 0)
    this.stiffness = options.stiffness ?? 3000
    this.damping = options.damping ?? 60
    this.referenceAngle = (b?.angle ?? 0) - (a?.angle ?? 0)
  }

  prepare() {
    const { a, b } = this
    if (!a || !b || !this.enabled) return
    const pa = a.worldPoint(this.localAnchorA)
    const pb = b.worldPoint(this.localAnchorB)
    const delta = Vec2.sub(pb, pa)
    const va = a.velocityAt(pa)
    const vb = b.velocityAt(pb)
    const rel = Vec2.sub(vb, va)
    const force = delta.clone().scale(this.stiffness).addScaled(rel, this.damping)
    a.applyForce(force.clone().negate(), pa)
    b.applyForce(force, pb)

    const angularError = angleDelta(b.angle - a.angle, this.referenceAngle)
    const torque = angularError * this.stiffness * 0.02 - (b.angularVelocity - a.angularVelocity) * this.damping * 0.05
    a.applyTorque(-torque)
    b.applyTorque(torque)
  }
}

/**
 * RopeJoint — a unilateral distance limiter: free inside `maxLength`, infinitely
 * stiff at the limit. Powers the winch on the conveyor demo.
 */
export class RopeJoint extends Joint {
  constructor(a, b, options = {}) {
    super(a, b)
    this.maxLength = options.maxLength ?? 120
  }

  prepare() {
    const { a, b } = this
    if (!a || !b || !this.enabled) return
    const d = Vec2.sub(b.position, a.position)
    const length = d.length()
    if (length <= this.maxLength || length < 1e-6) return
    d.scale(1 / length)
    const invMassSum = a.invMass + b.invMass
    if (invMassSum === 0) return
    // Remove the velocity component that would stretch the rope further.
    const rel = Vec2.sub(b.velocity, a.velocity)
    const vn = rel.dot(d)
    if (vn <= 0) return
    const j = -vn / invMassSum
    const impulse = d.scale(j)
    a.applyImpulse(impulse.clone().negate())
    b.applyImpulse(impulse)
  }
}
