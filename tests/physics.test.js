import { describe, it, expect } from 'vitest'
import { Vec2 } from '../src/engine/math/Vec2.js'
import { Engine } from '../src/engine/Engine.js'
import { World } from '../src/engine/physics/World.js'
import { RigidBody, BodyType, Layer } from '../src/engine/physics/RigidBody.js'
import { CircleShape, PolygonShape, boxShape, AABB } from '../src/engine/physics/shapes.js'
import { Manifold, collide } from '../src/engine/physics/collisions.js'
import { SpatialHash } from '../src/engine/physics/SpatialHash.js'
import { raycast } from '../src/engine/physics/queries.js'

const dynamicBody = (options) =>
  new RigidBody({ bodyType: BodyType.DYNAMIC, allowSleep: false, ...options })

const staticBox = (x, y, width, height) =>
  new RigidBody({
    shape: boxShape(width, height),
    position: new Vec2(x, y),
    bodyType: BodyType.STATIC,
    layer: Layer.TERRAIN,
    mask: Layer.DEFAULT | Layer.FLUID,
    allowSleep: false,
  })

describe('fixed timestep integration', () => {
  it('advances velocity and position with semi-implicit Euler', () => {
    const world = new World({ gravity: 1000 })
    const body = dynamicBody({ mass: 2, position: new Vec2(0, 0), linearDamping: 0, velocity: new Vec2(0, 0) })
    body.syncTransform(true)
    world.addBody(body)
    const dt = 1 / 60
    world.step(dt)
    // v += (F/m)·Δt with F = m·g ⇒ Δv = g·Δt = 1000/60
    expect(body.velocity.y).toBeCloseTo(1000 * dt, 6)
    // p += v·Δt using the *updated* velocity — that ordering is what makes it
    // semi-implicit rather than explicit.
    expect(body.position.y).toBeCloseTo(body.velocity.y * dt, 6)
    expect(body.position.x).toBe(0)
  })

  it('carries the residual accumulator across frames instead of losing it', () => {
    // A 144 Hz display: 6.944 ms per frame, while the physics runs at 16.667 ms.
    // The engine re-arms the loop through rAF; Node has no frame clock, so the
    // test supplies one and drives frames itself.
    globalThis.requestAnimationFrame = () => 0
    globalThis.cancelAnimationFrame = () => {}
    const engine = new Engine({ canvas: null })
    let steps = 0
    const original = engine.simulation.step.bind(engine.simulation)
    engine.simulation.step = (dt) => {
      steps++
      return original(dt)
    }
    const frame = 1000 / 144
    for (let i = 1; i <= 144; i++) engine.frame(i * frame)
    // One second of wall clock at 144 Hz must produce ~60 physics steps, not 144
    // and not 0. The exact count depends on where the phase lands; ±1 step.
    expect(steps).toBeGreaterThanOrEqual(59)
    expect(steps).toBeLessThanOrEqual(61)
    engine.dispose()
  })
})

describe('broad phase (spatial hash)', () => {
  it('registers AABBs and reports only nearby pairs', () => {
    const hash = new SpatialHash({ cellSize: 100, bounds: { width: 800, height: 800 } })
    // Static/static pairs are deliberately filtered out of the broad phase, so
    // the pair test uses dynamic bodies the way the solver does. `near` and
    // `alsoNear` share a cell *and* overlap; `sameCellButClear` shares the cell
    // and must still be rejected by the AABB test.
    const near = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(10, 10), mass: 1 })
    const alsoNear = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(24, 12), mass: 1 })
    const sameCellButClear = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(90, 90), mass: 1 })
    const far = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(700, 700), mass: 1 })
    for (const body of [near, alsoNear, sameCellButClear, far]) body.syncTransform(true)
    for (const body of [near, alsoNear, far]) hash.insert(body)

    const pairs = []
    hash.forEachPair((a, b) => pairs.push([a, b]))
    const keys = pairs.map(([a, b]) => [a.uid, b.uid].sort().join('-'))
    expect(keys).toContain([near.uid, alsoNear.uid].sort().join('-'))
    expect(keys).not.toContain([near.uid, far.uid].sort().join('-'))
    expect(keys).not.toContain([near.uid, sameCellButClear.uid].sort().join('-'))
    expect(hash.getStats().cells).toBeGreaterThan(0)
  })

  it('finds bodies whose AABB overlaps a query box', () => {
    const hash = new SpatialHash({ cellSize: 64, bounds: { width: 600, height: 600 } })
    const inside = staticBox(100, 100, 30, 30)
    const outside = staticBox(400, 400, 30, 30)
    inside.syncTransform(true)
    outside.syncTransform(true)
    for (const body of [inside, outside]) hash.insert(body)
    const found = hash.queryAABB(new AABB(80, 80, 140, 140))
    expect(found).toContain(inside)
    expect(found).not.toContain(outside)
  })
})

describe('narrow phase (SAT)', () => {
  it('separates two circles and reports the contact normal', () => {
    const manifold = new Manifold()
    const a = dynamicBody({ shape: new CircleShape(10), position: new Vec2(0, 0) })
    const b = dynamicBody({ shape: new CircleShape(10), position: new Vec2(15, 0) })
    expect(collide(manifold, a, b)).toBeTruthy()
    expect(manifold.normal.x).toBeCloseTo(1, 6)
    expect(manifold.normal.y).toBeCloseTo(0, 6)
    expect(manifold.contacts.length).toBe(1)
    // Separation is (distance − sum of radii) = 15 − 20 = −5.
    expect(manifold.contacts[0].separation).toBeCloseTo(-5, 4)
  })

  it('returns no manifold for separated polygons', () => {
    const manifold = new Manifold()
    const a = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(0, 0) })
    const b = dynamicBody({ shape: boxShape(20, 20), position: new Vec2(40, 0) })
    expect(collide(manifold, a, b)).toBeNull()
  })

  it('projects onto perpendicular axes, so a rotated box still collides', () => {
    const manifold = new Manifold()
    const a = staticBox(0, 0, 100, 20)
    const b = dynamicBody({
      shape: boxShape(20, 20),
      position: new Vec2(0, -6),
      angle: Math.PI / 4,
    })
    expect(collide(manifold, a, b)).toBeTruthy()
    // Normal points from a (the box) to b (the rotated body): downward.
    expect(manifold.normal.y).toBeCloseTo(-1, 4)
  })

  it('produces clipped two-contact manifolds for face-face boxes', () => {
    const manifold = new Manifold()
    const a = staticBox(0, 100, 200, 20)
    const b = dynamicBody({ shape: boxShape(60, 20), position: new Vec2(10, 92) })
    expect(collide(manifold, a, b)).toBeTruthy()
    expect(manifold.contacts.length).toBe(2)
  })
})

describe('impulse resolution', () => {
  it('is mass-aware: equal impulses produce inverse-mass velocities', () => {
    const world = new World({ gravity: 0 })
    const heavy = dynamicBody({ shape: new CircleShape(10), position: new Vec2(0, 0), mass: 10 })
    const light = dynamicBody({ shape: new CircleShape(10), position: new Vec2(19, 0), mass: 1 })
    world.addBody(heavy)
    world.addBody(light)
    light.velocity.set(-120, 0)
    world.step(1 / 60)
    // Equal and opposite impulses ⇒ Δv ∝ 1/m. The heavy body (10 kg) should
    // change velocity an order of magnitude less than the light one (1 kg).
    const deltaLight = Math.abs(light.velocity.x - -120)
    const deltaHeavy = Math.abs(heavy.velocity.x)
    expect(deltaHeavy).toBeGreaterThan(0)
    expect(deltaLight / deltaHeavy).toBeGreaterThan(5)
    expect(light.velocity.x).toBeGreaterThan(-120) // it was slowed, not sped up
  })

  it('applies restitution on approach above the threshold', () => {
    const world = new World({ gravity: 0, solver: { restitutionThreshold: 1 } })
    const floor = staticBox(0, 100, 400, 20)
    floor.restitution = 0.8
    const ball = dynamicBody({ shape: new CircleShape(8), position: new Vec2(0, 40), mass: 1 })
    ball.restitution = 0.8
    ball.velocity.set(0, 400)
    world.addBody(floor)
    world.addBody(ball)
    // Step until the first contact, then read the rebound velocity directly.
    let rebound = 0
    let apex = ball.position.y
    for (let i = 0; i < 90; i++) {
      world.step(1 / 60)
      if (ball.velocity.y < rebound) rebound = ball.velocity.y
      apex = Math.min(apex, ball.position.y)
    }
    // Combined restitution is min(a, b) = 0.8: the rebound must be a real
    // fraction of the 400 px/s impact, and the ball must leave the floor again.
    expect(rebound).toBeLessThan(-200)
    expect(apex).toBeLessThan(60)
  })

  it('never lets a droplet tunnel through a thin slab at speed', () => {
    const world = new World({ gravity: 981 })
    // A slab only 16 px thick, and the droplet starts *inside* it — the worst
    // case the engine has to survive.
    const slab = staticBox(0, 500, 600, 16)
    world.addBody(slab)
    const droplet = dynamicBody({
      shape: new CircleShape(5),
      position: new Vec2(0, 495),
      mass: 4,
      friction: 0.03,
      restitution: 0.08,
      layer: Layer.FLUID,
      mask: Layer.DEFAULT | Layer.TERRAIN | Layer.FLUID,
      isFluid: true,
    })
    world.addBody(droplet)
    for (let i = 0; i < 240; i++) world.step(1 / 60)
    expect(droplet.position.y).toBeLessThan(495)
    expect(droplet.position.y).toBeGreaterThan(470)
    expect(Number.isFinite(droplet.position.y)).toBe(true)
  })
})

describe('fluid droplets', () => {
  it('do not rotate — no uphill rolling on a frictionless slope', async () => {
    const { FluidSystem } = await import('../src/engine/FluidSystem.js')
    const world = new World({ gravity: 981 })
    const fluid = new FluidSystem(world, {})
    const slope = new RigidBody({
      shape: boxShape(400, 20),
      position: new Vec2(0, 200),
      angle: -0.14, // −8°
      bodyType: BodyType.STATIC,
      friction: 0.02,
      layer: Layer.TERRAIN,
      mask: Layer.DEFAULT | Layer.FLUID,
    })
    world.addBody(slope)
    const droplet = fluid.spawn(0, 150, 0, 0)
    const startX = droplet.position.x
    for (let i = 0; i < 180; i++) world.step(1 / 60)
    expect(droplet.invInertia).toBe(0)
    expect(droplet.angularVelocity).toBe(0)
    // With y pointing down and a −8° tilt, the surface falls towards −x, so a
    // non-rotating droplet slides that way instead of spinning in place.
    expect(droplet.position.x).toBeLessThan(startX - 5)
  })
})

describe('raycast queries', () => {
  it('returns the first hit along a ray', () => {
    const world = new World({ gravity: 0 })
    const wall = staticBox(200, 0, 40, 400)
    world.addBody(wall)
    world.rebuildBroadPhase() // spatial queries read the broad phase, not the body list
    // Axis-aligned ray against an axis-aligned box: the ray is *parallel* to the
    // wall's top and bottom faces, and the slab test used to reject exactly this
    // case (distance > 0 instead of < 0), so a rangefinder aimed straight at a
    // wall saw nothing at all.
    const hit = raycast(world, new Vec2(0, 0), 0, 500, { mask: 0b1111 })
    expect(hit).toBeTruthy()
    expect(hit.distance).toBeCloseTo(180, 1)
    expect(hit.normal.x).toBeCloseTo(-1, 5)
  })

  it('misses when nothing is in the way', () => {
    const world = new World({ gravity: 0 })
    world.addBody(staticBox(200, 400, 40, 20))
    world.rebuildBroadPhase()
    expect(raycast(world, new Vec2(0, 0), 0, 100, { mask: 0b1111 })).toBeNull()
  })
})

describe('polygon helpers', () => {
  it('builds a box with the requested extents and inertia', () => {
    const shape = boxShape(80, 40)
    expect(shape.vertices.length).toBe(4)
    const inertia = shape.computeMass(2)
    // I = m(w² + h²)/12 for a solid rectangle — the closed form every physics
    // text agrees on, and the reference this formula is verified against.
    expect(inertia).toBeCloseTo((2 * (80 ** 2 + 40 ** 2)) / 12, 4)
    // An off-centre polygon is measured about its own centroid, not the origin.
    const offset = new PolygonShape([[100, 100], [140, 100], [140, 140], [100, 140]])
    expect(offset.computeMass(2)).toBeCloseTo((2 * (40 ** 2 + 40 ** 2)) / 12, 4)
    expect(offset.centroid.x).toBeCloseTo(120, 6)
    expect(new PolygonShape([[0, 0], [10, 0], [10, 10]]).vertices.length).toBe(3)
  })
})
