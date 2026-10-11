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
        body.inertia = 1
        body.invInertia = 1
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
   * Push every droplet inside `radius` toward `direction`.
   *
   * This is an **acceleration field**, not a force field: the applied force is
   * scaled by each droplet's own mass, so the pump lifts a light mist and a
   * heavy slug of water identically. (A raw force field would fling low-mass
   * particles at absurd speeds — the classic particle-physics blow-up.)
   *
   *   a(p) = strength · (1 − d/r) · d̂  +  swirl · t̂
   */
  applyFlowField(origin, direction, radius, strength, swirl = 0) {
    const box = {
      minX: origin.x - radius,
      minY: origin.y - radius,
      maxX: origin.x + radius,
      maxY: origin.y + radius,
    }
    const bodies = this.world.spatialHash.queryAABB(box, this._queryScratch)
    const dirAngle = Math.atan2(direction.y, direction.x)
    let affected = 0
    for (const body of bodies) {
      if (!body.isFluid || body.removed || !body.enabled) continue
      const dx = body.position.x - origin.x
      const dy = body.position.y - origin.y
      const distance = Math.hypot(dx, dy)
      if (distance > radius) continue
      const falloff = 1 - distance / radius
      const scale = body.mass * falloff
      const fx = direction.x * strength * scale
      const fy = direction.y * strength * scale
      body.applyForce(new Vec2(fx, fy))
      if (swirl !== 0) {
        // Tangential component: rotate the radial vector by ±90°.
        const tangential = new Vec2(-dy, dx).scale((swirl * falloff * body.mass) / (distance || 1))
        body.applyForce(tangential)
      }
      body.wake()
      affected++
    }
    return affected
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
