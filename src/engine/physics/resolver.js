import { Vec2 } from '../math/Vec2.js'

/**
 * Contact solver — sequential impulses.
 *
 * Each contact is resolved as an instantaneous velocity change (an *impulse*)
 * rather than a force, which is what lets springs, stacks and hard impacts be
 * solved in a fixed number of iterations without exploding.
 *
 * Normal impulse for one iteration:
 *
 *          −(1 + e)·(v_rel · n̂) + bias
 *   j = ───────────────────────────────────────
 *        1/m_A + 1/m_B + (r_A × n̂)²/I_A + (r_B × n̂)²/I_B
 *
 * The denominator is the *effective mass* along the normal: it folds in both
 * bodies' inverse masses **and** the rotational inertia contribution of an
 * off-centre contact point, which is why a crate hit near a corner spins.
 * Impulses accumulate (the PGS formulation) and are clamped to j ≥ 0 so
 * contacts can push but never pull.
 *
 * Friction is a Coulomb-limited tangential impulse clamped into the friction
 * cone |j_t| ≤ μ·j_n, evaluated against the *accumulated* normal impulse, so it
 * grows with how hard the bodies are pressed together.
 *
 * Penetration is removed with Baumgarte stabilisation (`bias` = a fraction of
 * the positional error per step) plus a slop term, so resting stacks do not
 * visibly sink into each other and positional error never feeds raw energy back
 * into the velocity state.
 */

// Module-scope scratch vectors: the solver runs 10⁴+ times per second and must
// not allocate.
const _impulse = new Vec2()
const _negImpulse = new Vec2()
const _dva = new Vec2()
const _dvb = new Vec2()
const _relative = new Vec2()

export class Arbiter {
  constructor(a, b) {
    this.a = a
    this.b = b
    this.contacts = []
    this.normal = new Vec2(0, 0)
    this.tangent = new Vec2(0, 0)
    this.friction = 0
    this.restitution = 0
    this.touching = false
    this.stamp = 0
    this._pool = []
  }

  /** Rebuild contacts from a manifold, carrying warm-start impulses forward. */
  update(manifold) {
    const previous = this.contacts
    const pool = this._pool
    const next = []

    for (const incoming of manifold.contacts) {
      // Match old contacts by geometric feature so impulses flow from the same
      // physical corner from frame to frame — this is what removes the
      // micro-jitter of a box resting on the ground.
      let matched = null
      for (const old of previous) {
        if (old.featureId === incoming.featureId) {
          matched = old
          break
        }
      }
      const contact = matched ?? pool.pop() ?? {
        point: new Vec2(),
        rA: new Vec2(),
        rB: new Vec2(),
        featureId: -1,
        separation: 0,
        normalImpulse: 0,
        tangentImpulse: 0,
        massNormal: 0,
        massTangent: 0,
        bias: 0,
        restitutionBias: 0,
        pointMass: 0,
      }
      contact.point.copy(incoming.point)
      contact.separation = incoming.separation
      contact.featureId = incoming.featureId
      if (!matched) {
        contact.normalImpulse = 0
        contact.tangentImpulse = 0
      }
      next.push(contact)
    }
    for (const old of previous) {
      if (!next.includes(old)) pool.push(old)
    }

    this.normal.copy(manifold.normal)
    this.tangent.set(manifold.normal.y, -manifold.normal.x)
    this.friction = manifold.friction
    this.restitution = manifold.restitution
    this.contacts = next
    this.touching = next.length > 0
  }

  preStep(invDt, config) {
    const { a, b, normal: n, tangent: tangent } = this

    for (const contact of this.contacts) {
      contact.rA.set(contact.point.x - a.position.x, contact.point.y - a.position.y)
      contact.rB.set(contact.point.x - b.position.x, contact.point.y - b.position.y)

      // --- normal effective mass:  1/(1/mA + 1/mB + (rA×n)²/IA + (rB×n)²/IB)
      const rnA = contact.rA.cross(n)
      const rnB = contact.rB.cross(n)
      const kn = a.invMass + b.invMass + a.invInertia * rnA * rnA + b.invInertia * rnB * rnB
      contact.massNormal = kn > 0 ? 1 / kn : 0

      // --- tangent effective mass ----------------------------------------
      const rtA = contact.rA.cross(tangent)
      const rtB = contact.rB.cross(tangent)
      const kt = a.invMass + b.invMass + a.invInertia * rtA * rtA + b.invInertia * rtB * rtB
      contact.massTangent = kt > 0 ? 1 / kt : 0

      // --- positional correction (Baumgarte, with slop) ------------------
      // separation < 0 means penetration. Two sign traps live on this line and
      // both of them silently disable extrusion:
      //
      //   * overlap = −separation − slop  (not separation + slop — that is
      //     always negative while touching, so `max(0, …)` erases the term and
      //     penetration is never corrected),
      //   * bias is added *into* a non-negative normal impulse Pn = m_eff(−v_n
      //     + bias) with `n` pointing a → b, so a positive bias separates. A
      //     negative bias could only ever cancel the impulse back to zero.
      const overlap = Math.max(0, -contact.separation - config.allowedPenetration)
      contact.bias = Math.min(
        config.biasFactor * invDt * overlap,
        config.maxBiasVelocity,
      )

      // --- restitution from the *approach* velocity ----------------------
      const va = a.velocityAtInto(contact.point, _dva)
      const vb = b.velocityAtInto(contact.point, _dvb)
      const vn = _relative.set(vb.x - va.x, vb.y - va.y).dot(n)
      // Bodies separating faster than the threshold are treated as inelastic so
      // resting contacts do not buzz.
      contact.restitutionBias =
        vn < -config.restitutionThreshold ? -this.restitution * vn : 0
    }

    if (config.warmStarting) {
      for (const contact of this.contacts) {
        _impulse.set(
          n.x * contact.normalImpulse + tangent.x * contact.tangentImpulse,
          n.y * contact.normalImpulse + tangent.y * contact.tangentImpulse,
        )
        a.applyImpulseAtOffset(_impulse.negatedInto(_negImpulse), contact.rA)
        b.applyImpulseAtOffset(_impulse, contact.rB)
      }
    }
  }

  /** One Gauss-Seidel sweep over this arbiter's contacts. */
  applyImpulse() {
    const { a, b, normal: n, tangent: tangent } = this

    for (const contact of this.contacts) {
      // ---- normal impulse (accumulated, clamped ≥ 0) ---------------------
      const va = a.velocityAtInto(contact.point, _dva)
      const vb = b.velocityAtInto(contact.point, _dvb)
      const vn = (vb.x - va.x) * n.x + (vb.y - va.y) * n.y

      const newPn = Math.max(
        contact.normalImpulse + contact.massNormal * (-vn + contact.bias + contact.restitutionBias),
        0,
      )
      const dPn = newPn - contact.normalImpulse
      contact.normalImpulse = newPn

      _impulse.set(n.x * dPn, n.y * dPn)
      a.applyImpulseAtOffset(_impulse.negatedInto(_negImpulse), contact.rA)
      b.applyImpulseAtOffset(_impulse, contact.rB)

      // ---- tangential (friction) impulse ---------------------------------
      const va2 = a.velocityAtInto(contact.point, _dva)
      const vb2 = b.velocityAtInto(contact.point, _dvb)
      const vt = (vb2.x - va2.x) * tangent.x + (vb2.y - va2.y) * tangent.y

      const maxPt = this.friction * contact.normalImpulse
      const newPt = Math.max(
        -maxPt,
        Math.min(maxPt, contact.tangentImpulse + contact.massTangent * -vt),
      )
      const dPt = newPt - contact.tangentImpulse
      contact.tangentImpulse = newPt

      _impulse.set(tangent.x * dPt, tangent.y * dPt)
      a.applyImpulseAtOffset(_impulse.negatedInto(_negImpulse), contact.rA)
      b.applyImpulseAtOffset(_impulse, contact.rB)
    }
  }
}
