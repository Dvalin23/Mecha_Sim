import { RigidBody, BodyType, Layer } from '../physics/RigidBody.js'
import { boxShape, CircleShape, regularPolygonShape } from '../physics/shapes.js'
import { Vec2 } from '../math/Vec2.js'
import { uuid } from './../ids.js'

/**
 * Factories for the rigid bodies that give mechatronic parts a physical
 * presence. Collision filtering follows a simple, predictable rule:
 *
 *   TERRAIN (static fixtures)  ↔  DEFAULT (dynamic parts)  +  FLUID (water)
 *   DEFAULT                    ↔  TERRAIN + DEFAULT + FLUID
 *   FLUID                      ↔  TERRAIN + DEFAULT + FLUID
 *
 * Static bodies never collide with each other, so a wall buried inside another
 * wall costs nothing.
 */

export const ALL_LAYERS = Layer.DEFAULT | Layer.TERRAIN | Layer.FLUID

export function staticBox({ x, y, width, height, angle = 0, tag = 'fixture', id = uuid(), userData = null, material = 'metal' }) {
  const body = new RigidBody({
    id,
    tag,
    shape: boxShape(width, height),
    position: new Vec2(x, y),
    angle,
    bodyType: BodyType.STATIC,
    restitution: material === 'rubber' ? 0.35 : 0.05,
    friction: material === 'ice' ? 0.02 : material === 'rubber' ? 0.9 : 0.55,
    layer: Layer.TERRAIN,
    mask: Layer.DEFAULT | Layer.FLUID,
    allowSleep: false,
    userData,
  })
  body.material = material
  return body
}

export function dynamicBox({ x, y, width, height, angle = 0, mass = 2, tag = 'part', restitution = 0.15, friction = 0.5, userData = null, linearDamping = 0.02 }) {
  return new RigidBody({
    shape: boxShape(width, height),
    position: new Vec2(x, y),
    angle,
    bodyType: BodyType.DYNAMIC,
    mass,
    restitution,
    friction,
    linearDamping,
    layer: Layer.DEFAULT,
    mask: ALL_LAYERS,
    tag,
    userData,
  })
}

export function dynamicCircle({ x, y, radius, mass = 2, tag = 'part', restitution = 0.25, friction = 0.4, userData = null }) {
  return new RigidBody({
    shape: new CircleShape(radius),
    position: new Vec2(x, y),
    bodyType: BodyType.DYNAMIC,
    mass,
    restitution,
    friction,
    layer: Layer.DEFAULT,
    mask: ALL_LAYERS,
    tag,
    userData,
  })
}

/** Rotor/impeller: a dynamic disc that a MotorJoint can drive. */
export function rotor({ x, y, radius, mass = 1.6, tag = 'rotor', userData = null, sides = 12 }) {
  return new RigidBody({
    shape: regularPolygonShape(radius, sides),
    position: new Vec2(x, y),
    bodyType: BodyType.DYNAMIC,
    mass,
    restitution: 0.2,
    friction: 0.4,
    angularDamping: 0.35,
    linearDamping: 0.6,
    fixedRotation: false,
    layer: Layer.DEFAULT,
    mask: ALL_LAYERS,
    tag,
    userData,
  })
}

/** Position-driven gate (valve piston, robot arm): kinematic, never pushed. */
export function kinematicBox({ x, y, width, height, angle = 0, tag = 'gate', userData = null }) {
  return new RigidBody({
    shape: boxShape(width, height),
    position: new Vec2(x, y),
    angle,
    bodyType: BodyType.KINEMATIC,
    friction: 0.7,
    restitution: 0.02,
    layer: Layer.DEFAULT,
    mask: ALL_LAYERS,
    tag,
    userData,
  })
}

export { BodyType, Layer }
