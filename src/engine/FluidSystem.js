import { Vec2 } from './math/Vec2.js'
import { BodyType, Layer } from './physics/RigidBody.js'
import { CircleShape } from './physics/shapes.js'
import { RigidBody } from './physics/RigidBody.js'
import { Manifold, collide } from './physics/collisions.js'
import { mulberry32 } from './math/utils.js'

/**
 * FluidSystem — a particle pool that models pumped water.
 *
 * Droplets are ordinary circle `RigidBody`s on their own collision layer, so
 * they bounce, splash and pile up using the very same solver as everything else
 * — no special-case fluid solver. The only fluid-specific behaviours are:
 *
 *  * **Pooling** — particles are recycled instead of allocated (a scene can
 *    emit forever without an OOM or a GC hitch).
 *  * **Drag** — an extra velocity-proportional damping makes the particles
 *    behave like a viscous liquid rather than dry marbles.
 *  * **Emitter caps** — a hard ceiling on live particles keeps the broad phase
 *    within its per-step budget; the oldest particle is recycled when full.
 */
export class FluidSystem {
  constructor(world, options = {}) {
    const {
      maxParticles = 260,
      radius = 5,
      density = 0.02,
      restitution = 0.08,
      // Water has essentially no inter-granular friction. Keep a token amount
      // (not 0) because a perfectly frictionless contact makes a settled pile
      // free to shuffle forever; with 0.03 the angle of repose is ~2°, so sums
      // and piles drain out of a −8° tray instead of jamming (measured: a heap
      // on a −10° ice apron creeps at ~6 px/s at 0.12, and flows at 0.03).
      friction = 0.03,
      damping = 0.9,
      seed = 0x5eed,
    } = options

    this.world = world
    this.maxParticles = maxParticles
    this.radius = radius
    this.restitution = restitution
    this.friction = friction
    this.damping = damping
    this.density = density
    this.random = mulberry32(seed)

    this.pool = []
    this.active = []
    /** Initial water fills: part of the scene, so they survive save/reset. */
    this.initialFills = []
    this.emitters = new Map()
    this._queryScratch = []
  }

  get count() {
    return this.active.length
  }

  /**
   * Fill a rectangular region with droplets and *remember* it as an initial
   * condition of the scene.
   *
   * The fill descriptor (not the individual particles) is what gets serialized,
   * so a saved project stays a few hundred bytes instead of carrying a thousand
   * droplet coordinates — and a reset re-creates exactly the water the scene
   * started with.
   */
  fill(x, y, count, spreadX = 90, spreadY = 60, { record = true } = {}) {
    const columns = 14
    const rows = Math.max(1, Math.ceil(count / columns))
    for (let i = 0; i < count; i++) {
      const px = x + ((i % columns) - (columns - 1) / 2) * (spreadX / columns) + (this.random() - 0.5) * 3
      const py = y - Math.floor(i / columns) * (spreadY / rows) + (this.random() - 0.5) * 3
      this.spawn(px, py, 0, 0)
    }
    if (record) this.initialFills.push({ x, y, count, spreadX, spreadY })
    return this
  }

  /** Spawn a droplet at (x, y) with an initial velocity. */
  /**
   * Spawn one droplet.
   *
   * `depenetrate` (default) nudges the droplet out of anything solid it was
   * born inside. A water fill that overlaps a wall, a nozzle poking through a
   * floor or a user painting water into a ledge would otherwise strand droplets
   * *inside* static geometry, where the solver has no valid contact normal to
   * eject them along and they are simply lost (culled once they sink out of
   * the world). The fix reuses the narrow phase rather than inventing a second
   * geometry path: run the real circle-vs-shape collision and walk the droplet
   * back out along the contact normal.
   */
  spawn(x, y, vx = 0, vy = 0, { depenetrate = true } = {}) {
    let body = this.pool.pop()
    if (!body) {
      if (this.active.length >= this.maxParticles) {
        // Recycle the oldest droplet so emission never starves.
        body = this.active.shift()
      } else {
        body = this.world.addBody({
          shape: new CircleShape(this.radius),
          position: new Vec2(x, y),
          bodyType: BodyType.DYNAMIC,
          mass: Math.PI * this.radius * this.radius * this.density,
          restitution: this.restitution,
          friction: this.friction,
          linearDamping: this.damping,
          angularDamping: 1.4,
          quadraticDrag: 0.0007,
          layer: Layer.FLUID,
          mask: Layer.DEFAULT | Layer.TERRAIN | Layer.FLUID,
          tag: 'fluid',
          isFluid: true,
          allowSleep: true,
          continuous: false,
        })
        // Droplets do not rotate. A circle's real inertia would be ½mr², but
        // leaving an arbitrary `invInertia = 1` gives a 5 px droplet roughly 20×
        // its physical spin response — and friction acts 5 px off-centre, so the
        // contact torque dominates. The symptom is not a subtle one: beads roll
        // *uphill* on an 8° ice tray, oscillate around a phantom equilibrium and
        // a heap of them locks solid (measured: a pile that never drained with
        // the sluice wide open). Suppressing the rotational degree of freedom is
        // both cheaper and more faithful — water in this model is a spray of
        // sliding particles, not a bag of ball bearings.
        body.inertia = 0
        body.invInertia = 0
      }
    }
    body.removed = false
    body.enabled = true
    body.awake = true
    body.isFluid = true
    body.tag = 'fluid'
    body.setPosition(x, y)
    body.velocity.set(vx, vy)
    body.angularVelocity = 0
    if (!this.world.bodies.includes(body)) {
      body.removed = true
      this.world.addBody(body)
      body.removed = false
      this.world._pendingRemoval = this.world._pendingRemoval.filter((b) => b !== body)
    }
    if (depenetrate) this.depenetrate(body)
    this.active.push(body)
    return body
  }

  /**
   * Push a droplet out of any static body containing it, one contact at a time
   * (bounded so a pathological scene cannot spin here). Returns the number of
   * pushes applied — handy in tests.
   */
  depenetrate(body, maxPasses = 4) {
    const probe = this._probe ?? (this._probe = { manifold: new Manifold(), body: null })
    if (!probe.body) {
      probe.body = new RigidBody({
        shape: new CircleShape(this.radius),
        position: new Vec2(0, 0),
        bodyType: BodyType.DYNAMIC,
        mass: 1,
        layer: Layer.FLUID,
        mask: Layer.DEFAULT | Layer.TERRAIN | Layer.FLUID,
        tag: 'fluid-probe',
      })
      probe.body.inertia = 1
      probe.body.invInertia = 1
    }
    const scratch = probe.body
    let pushes = 0
    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = false
      for (const other of this.world.bodies) {
        if (other === body || other.removed || !other.isStatic) continue
        if (!other.aabb.overlaps(body.aabb)) continue
        scratch.setPosition(body.position.x, body.position.y)
        probe.manifold.reset()
        // The probe has the droplet's own radius, so the separation it reports
        // is already measured against the sprayed circle's surface.
        if (!collide(probe.manifold, scratch, other)) continue
        const contact = probe.manifold.contacts[0]
        if (!contact) continue
        const push = Math.min(-contact.separation + this.radius * 0.1, this.radius * 4)
        if (push <= 0) continue
        body.setPosition(
          body.position.x - probe.manifold.normal.x * push,
          body.position.y - probe.manifold.normal.y * push,
        )
        pushes += 1
        moved = true
      }
      if (!moved) break
    }
    return pushes
  }

  /** Remove a droplet and return it to the pool. */
  despawn(body) {
    const index = this.active.indexOf(body)
    if (index >= 0) this.active.splice(index, 1)
    body.enabled = false
    body.velocity.set(0, 0)
    body.removed = true
    if (!this.pool.includes(body)) this.pool.push(body)
    return this
  }

  clear() {
    for (const body of [...this.active]) this.despawn(body)
    return this
  }

  /**
   * Mass of fluid inside an axis-aligned region — this is how a tank knows how
   * full it is. Uses the spatial hash AABB query, so cost is proportional to the
   * number of droplets actually inside.
   */
  measureVolume(minX, minY, maxX, maxY) {
    const box = { minX, minY, maxX, maxY }
    const bodies = this.world.spatialHash.queryAABB(box, this._queryScratch)
    let count = 0
    let mass = 0
    for (const body of bodies) {
      if (!body.isFluid || body.removed || !body.enabled) continue
      if (
        body.position.x < minX ||
        body.position.x > maxX ||
        body.position.y < minY ||
        body.position.y > maxY
      )
        continue
      count++
      mass += body.mass
    }
    return { count, mass }
  }

  /**
   * The nearest point along a bearing where a droplet can be released without
   * being born inside solid geometry.
   *
   * A pump mounted in a housing — the suction duct on the demo station — points
   * *up its own duct*: releasing at the eye would embed the droplet in the duct
   * wall and the launch dies on the spot. Marching out until the path is clear
   * is the difference between "the pump throws water" and "the pump vibrates".
   */
  clearestRelease(origin, cos, sin, start, max) {
    const scratch = this._releaseScratch ?? (this._releaseScratch = [])
    const point = this._releasePoint ?? (this._releasePoint = new Vec2())
    const step = Math.max(Math.ceil(this.radius), 2)
    for (let distance = start; distance <= max; distance += step) {
      point.set(origin.x + cos * distance, origin.y + sin * distance)
      const candidates = this.world.spatialHash.queryPoint(point.x, point.y, scratch)
      let blocked = false
      for (const body of candidates) {
        if (body.isFluid || body.removed || !body.enabled) continue
        if (body.userData?.componentType === 'Pump') continue
        if (body.containsPoint(point)) {
          blocked = true
          break
        }
      }
      if (!blocked) return distance
    }
    return max
  }

  /**
   * Intake + ballistic launch — the pump model.
   *
   * The two models before this one failed in opposite directions, and both are
   * instructive:
   *
   *   · a uniform radial force field can *hold* water against gravity
   *     indefinitely — it pinned 150 droplets to a 10° ice chute and 44 to a
   *     closed sluice plate, so a machine could look busy forever without ever
   *     doing any work;
   *   · a suction well with a velocity-blend "eye" (`applyDraft`) could draw
   *     water in but its jet was whatever shape the force field happened to
   *     produce, and the closing step of the cycle was never reached: the deck
   *     filled to 18.6 % in 300 s, i.e. 33 of 150 droplets, and stopped.
   *
   * This one separates the two jobs a pump actually does:
   *
   *   1. **Intake is geometric.** Anything inside `eyeRadius` of the mouth is
   *      taken, nearest first, at most `intakeRate` per step. A real impeller
   *      cannot draw water it cannot reach, and treating intake as "in this box"
   *      means the eye always empties out — no droplet can orbit the mouth.
   *   2. **Launch is ballistic.** An intake droplet is placed at a *release
   *      point* one eye radius ahead along `launchSlope` — outside the intake
   *      radius, so it cannot be swallowed again — and given a velocity that
   *      carries it along that bearing for exactly this step. The trajectory is
   *      then set by the ejection speed alone (range = v²·sin 2θ/g), so the jet
   *      is a *designed* parabola you can aim at a chute instead of an emergent
   *      force-field artefact.
   *
   * Everything in the pool around the mouth still feels a gentle pull so it
   * refills the eye rather than sitting at the rim, but that pull is weak: it
   * must never be able to hold water up against gravity.
   *
   * @returns {number} droplets launched or drawn this step
   */
  applyIntake(origin, direction, dt, {
    radius = 200,
    strength = 4000,
    swirl = 0,
    eyeRadius = radius * 0.25,
    suctionRatio = 0.5,
    /** Launch bearing, in radians from +x. `null` follows the nozzle's own aim. */
    launchSlope = null,
    /** Droplets the eye can swallow in a single step. */
    intakeRate = 2,
    maxJetSpeed = 900,
  } = {}) {
    const candidates = this.world.spatialHash.queryAABB(
      { minX: origin.x - radius, minY: origin.y - radius, maxX: origin.x + radius, maxY: origin.y + radius },
      this._queryScratch,
    )
    const jetSpeed = Math.min(Math.sqrt(2 * strength * eyeRadius), maxJetSpeed)
    const suction = strength * suctionRatio
    const blend = Math.min(1, dt / 0.05)
    this.lastJetSpeed = jetSpeed

    const intake = []
    let drawn = 0
    for (const body of candidates) {
      if (!body.isFluid || body.removed || !body.enabled) continue
      const dx = body.position.x - origin.x
      const dy = body.position.y - origin.y
      const distance = Math.hypot(dx, dy)
      if (distance > radius) continue
      if (distance <= eyeRadius) {
        intake.push(body)
        continue
      }
      // Only water at or below the mouth's centre line is drawn in. Screen y
      // grows downward, so "below the mouth" is dy > 0; the guard keeps the
      // filled deck (60–150 px *above* the mouth) out of the draft.
      if (dy < -radius * 0.1) continue
      const falloff = 1 - distance / radius
      const scale = (suction * falloff * body.mass) / (distance || 1)
      body.applyForce(new Vec2(-dx * scale, -dy * scale))
      if (swirl !== 0) {
        body.applyForce(new Vec2(-dy, dx).scale((swirl * falloff * body.mass) / (distance || 1)))
      }
      body.wake()
      drawn++
    }

    if (intake.length === 0) {
      this.lastIntake = 0
      return drawn
    }

    // Nearest-first, so a queue at the mouth is served in order and the eye
    // cannot be monopolised by whichever droplet the hash happened to return.
    intake.sort((a, b) => a.position.distanceSq(origin) - b.position.distanceSq(origin))
    const batch = intake.slice(0, intakeRate)

    const bearing = launchSlope === null ? Math.atan2(direction.y, direction.x) : launchSlope
    const cos = Math.cos(bearing)
    const sin = Math.sin(bearing)
    // Where the water leaves the pump. Normally just past the eye, but a pump
    // mounted inside a housing — the suction duct on the demo station, say — has
    // to be able to throw water *out* of its own duct: releasing inside a wall
    // just embeds droplets in it and the jet dies on the spot. So march the
    // bearing outward past any solid the nozzle is buried in.
    const release = this.clearestRelease(origin, cos, sin, eyeRadius + this.radius + 1, Math.min(radius, 280))
    // Subtract one step of travel so that this step's integration — which only
    // adds gravity — lands the droplet exactly on the speed-`jetSpeed` parabola.
    const pushed = Math.max(jetSpeed - jetSpeed * dt, 0)

    for (const body of batch) {
      body.position.set(origin.x + cos * release, origin.y + sin * release)
      body.velocity.set(cos * pushed, sin * pushed)
      body.angularVelocity = 0
      body.wake()
    }

    this.lastIntake = batch.length
    return batch.length + drawn
  }

  /** Total kinetic energy of the fluid — shown in the debug HUD as a stability check. */
  kineticEnergy() {
    let ke = 0
    for (const body of this.active) ke += 0.5 * body.mass * body.velocity.lengthSq()
    return ke
  }

  /** Kill droplets that escaped the world (keeps the pool honest). */
  cullOutside(bounds, margin = 400) {
    let culled = 0
    for (const body of [...this.active]) {
      const p = body.position
      if (
        p.x < bounds.minX - margin ||
        p.x > bounds.maxX + margin ||
        p.y < bounds.minY - margin ||
        p.y > bounds.maxY + margin
      ) {
        this.despawn(body)
        culled++
      }
    }
    return culled
  }

  serialize() {
    return {
      seed: 0x5eed,
      maxParticles: this.maxParticles,
      radius: this.radius,
      particles: this.active.map((b) => [round(b.position.x), round(b.position.y)]),
    }
  }

  deserialize(data) {
    this.clear()
    if (!data) return
    if (data.maxParticles) this.maxParticles = data.maxParticles
    if (data.radius) this.radius = data.radius
    for (const [x, y] of data.particles ?? []) this.spawn(x, y)
  }
}

const round = (v) => Math.round(v * 100) / 100
