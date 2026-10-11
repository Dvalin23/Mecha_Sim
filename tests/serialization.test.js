import { describe, it, expect } from 'vitest'
import { Simulation } from '../src/engine/Simulation.js'
import { createComponent } from '../src/engine/registry.js'
import { Vec2 } from '../src/engine/math/Vec2.js'
import {
  serializeProject,
  serializeScene,
  upgradePayload,
  restoreScene,
  deserializeProject,
  PROJECT_FORMAT_VERSION,
} from '../src/engine/serialization.js'
import { validateProject, ruleSchema, LIMITS } from '../shared/schema.js'
import { Engine } from '../src/engine/Engine.js'
import { buildDemo } from '../src/engine/demos.js'

/** A deliberately cyclic rig: motor drives a paddle, the relay switches it. */
function cyclicRig() {
  const sim = new Simulation()
  const mcu = createComponent('Controller', {
    position: new Vec2(0, 0),
    properties: { rules: [{ id: 'r', source: 'in0', target: 'out0', mode: 'above', threshold: 10, hysteresis: 2 }] },
  })
  const relay = createComponent('Relay', { position: new Vec2(200, 0) })
  const motor = createComponent('Motor', { position: new Vec2(400, 0) })
  const sensor = createComponent('UltrasonicSensor', { position: new Vec2(-200, 0) })
  for (const component of [mcu, relay, motor, sensor]) sim.add(component, { silent: true })
  sim.connect(sensor.id, 'distance', mcu.id, 'in0', { silent: true })
  sim.connect(mcu.id, 'out0', relay.id, 'coil', { silent: true })
  sim.connect(relay.id, 'switched', motor.id, 'power', { silent: true })
  // Feedback: the motor's speed is read back by the controller — a cycle the
  // serializer has to survive.
  sim.connect(motor.id, 'rpm', mcu.id, 'in1', { silent: true })
  return { sim, mcu, relay, motor, sensor }
}

describe('wire format', () => {
  it('replaces memory references with UUID strings', () => {
    const { sim, mcu, relay, motor } = cyclicRig()
    const payload = serializeProject(sim)

    for (const node of payload.nodes) {
      expect(typeof node.id).toBe('string')
      expect(node.id.length).toBeGreaterThan(4)
      expect(node.properties).toBeTypeOf('object')
    }
    // Every wire is two string ids plus two port names — no object graph.
    for (const edge of payload.edges) {
      expect(typeof edge.from.node).toBe('string')
      expect(typeof edge.from.port).toBe('string')
      expect(typeof edge.to.node).toBe('string')
      expect(typeof edge.to.port).toBe('string')
      expect(edge.from.node).not.toBe(edge.to.node)
    }
    // The cyclic pair is present in both directions.
    const pairs = payload.edges.map((e) => `${e.from.node}->${e.to.node}`)
    expect(pairs).toContain(`${relay.id}->${motor.id}`)
    expect(pairs).toContain(`${motor.id}->${mcu.id}`)
    expect(pairs).toContain(`${mcu.id}->${relay.id}`)
  })

  it('is plain JSON — no cycles, no class instances', () => {
    const { sim } = cyclicRig()
    const payload = serializeProject(sim)
    const text = JSON.stringify(payload)
    expect(text.length).toBeGreaterThan(100)
    expect(() => JSON.parse(text)).not.toThrow()
    const round = JSON.parse(text)
    expect(round.formatVersion).toBe(PROJECT_FORMAT_VERSION)
    expect(round.nodes.length).toBe(sim.componentList.length)
    expect(round.edges.length).toBe(sim.edges.length)
  })

  it('rebuilds live ES6 instances and the connections map on load', () => {
    const { sim } = cyclicRig()
    const payload = serializeProject(sim)
    const rebuilt = deserializeProject(JSON.parse(JSON.stringify(payload)))

    expect(rebuilt.componentList.length).toBe(sim.componentList.length)
    expect(rebuilt.edges.length).toBe(sim.edges.length)
    // Real class instances, not plain objects.
    const motor = rebuilt.componentList.find((c) => c.type === 'Motor')
    expect(motor.constructor.name).toBe('Motor')
    expect(motor.update).toBeTypeOf('function')
    expect(motor.rotation).toBeTypeOf('number')
    // The feedback wire resolves through the rebuilt map.
    const incoming = rebuilt.incoming(motor.id, 'power')
    expect(incoming.length).toBe(1)
    expect(incoming[0].from.port).toBe('switched')
    expect(rebuilt.get(incoming[0].from.node).type).toBe('Relay')
  })

  it('round-trips through a save/load cycle without drift', () => {
    const { sim } = cyclicRig()
    const first = serializeProject(sim)
    const rebuilt = deserializeProject(JSON.parse(JSON.stringify(first)))
    const second = serializeProject(rebuilt)
    expect(second.nodes.map((n) => n.id).sort()).toEqual(first.nodes.map((n) => n.id).sort())
    expect(second.edges.length).toBe(first.edges.length)
    // Positions and rotations survive the trip exactly at the stored precision.
    for (const node of first.nodes) {
      const other = second.nodes.find((n) => n.id === node.id)
      expect(other.x).toBeCloseTo(node.x, 6)
      expect(other.y).toBeCloseTo(node.y, 6)
      expect(other.rotation).toBeCloseTo(node.rotation, 6)
    }
  })

  it('keeps water as fills rather than hundreds of coordinates', () => {
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'proximity-pump')
    const payload = engine.serialize()
    expect(Array.isArray(payload.fluid)).toBe(true)
    expect(payload.fluid[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number), count: expect.any(Number) })
    // 150 droplets in one fill ⇒ a handful of numbers on the wire.
    expect(JSON.stringify(payload.fluid).length).toBeLessThan(120)
    const reloaded = deserializeProject(JSON.parse(JSON.stringify(payload)))
    expect(reloaded.fluid.count).toBe(150)
    engine.dispose()
  })

  it('upgrades an older payload instead of refusing it', () => {
    const legacy = {
      formatVersion: 1,
      name: 'Legacy',
      nodes: [{ id: 'a', type: 'Lamp', x: 10, y: 20, properties: { color: 'amber' } }],
      edges: [],
    }
    const upgraded = upgradePayload(legacy)
    expect(upgraded.formatVersion).toBe(PROJECT_FORMAT_VERSION)
    expect(upgraded.nodes[0].id).toBe('a')
    const sim = new Simulation()
    restoreScene(sim, upgraded)
    expect(sim.componentList.length).toBe(1)
    expect(sim.componentList[0].type).toBe('Lamp')
  })

  it('drops a wire whose endpoints no longer exist rather than throwing', () => {
    const sim = new Simulation()
    const scene = {
      nodes: [{ id: 'only', type: 'Lamp', x: 0, y: 0, rotation: 0, properties: {} }],
      edges: [{ id: 'e', from: { node: 'only', port: 'power' }, to: { node: 'ghost', port: 'power' } }],
    }
    expect(() => restoreScene(sim, scene)).not.toThrow()
    expect(sim.edges.length).toBe(0)
  })

  it('refuses a wire that would connect a component to itself', () => {
    const sim = new Simulation()
    const relay = createComponent('Relay', { position: new Vec2(0, 0) })
    sim.add(relay, { silent: true })
    expect(() => sim.connect(relay.id, 'switched', relay.id, 'coil')).toThrow(/itself/i)
  })
})

describe('strict validation (shared Zod schema)', () => {
  const valid = () => {
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'relay-lab')
    const payload = engine.serialize({ name: 'Relay lab' })
    engine.dispose()
    return payload
  }

  it('accepts a real scene', () => {
    const result = validateProject(valid())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects an unknown component type', () => {
    const payload = valid()
    payload.nodes[0].type = 'NuclearReactor'
    const result = validateProject(payload)
    expect(result.ok).toBe(false)
    expect(result.errors.some((issue) => issue.path.includes('type'))).toBe(true)
  })

  it('rejects coordinates that are not finite numbers', () => {
    const payload = valid()
    payload.nodes[0].x = NaN
    const result = validateProject(payload)
    expect(result.ok).toBe(false)
    payload.nodes[0].x = 1e12 // outside the world limits
    expect(validateProject(payload).ok).toBe(false)
  })

  it('rejects a malformed rule (this is the injection surface)', () => {
    // Use a scene that actually contains a Controller: `relay-lab` does not, and
    // a rule can only be smuggled in on a node that has them.
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'proximity-pump')
    const payload = engine.serialize({ name: 'Injection test' })
    engine.dispose()
    const controller = payload.nodes.find((node) => node.type === 'Controller')
    expect(controller).toBeTruthy()

    controller.properties.rules = [{ id: 'r', source: 'in0', target: 'out0', mode: 'sideways', threshold: 'hi' }]
    const result = validateProject(payload)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].path).toMatch(/rules/)

    // A well-formed edit of the same node still passes.
    controller.properties.rules = [{ id: 'r', source: 'in0', target: 'out0', mode: 'above', threshold: 40 }]
    expect(validateProject(payload).ok).toBe(true)
  })

  it('rejects duplicate node ids and dangling wires', () => {
    const payload = valid()
    payload.nodes[1].id = payload.nodes[0].id
    expect(validateProject(payload).ok).toBe(false)

    const second = valid()
    second.edges.push({ id: 'x', from: { node: second.nodes[0].id, port: 'a' }, to: { node: 'nope', port: 'b' } })
    expect(validateProject(second).ok).toBe(false)
  })

  it('rejects an empty scene and a payload that is not an object', () => {
    expect(validateProject({ nodes: [] }).ok).toBe(false)
    expect(validateProject(null).ok).toBe(false)
    expect(validateProject('{}').ok).toBe(false)
    // Geometry is mandatory: a node without a position is not a placeable part.
    expect(validateProject({ nodes: [{ id: 'x', type: 'Lamp' }], edges: [] }).ok).toBe(false)
    expect(validateProject({ nodes: [{ id: 'x', type: 'Lamp', x: 10, y: 20 }], edges: [] }).ok).toBe(true)
  })

  it('enforces the size limit the API advertises', () => {
    expect(LIMITS.maxPayloadBytes).toBeGreaterThan(100_000)
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'physics-showroom')
    const payload = engine.serialize()
    const size = JSON.stringify(payload).length
    expect(size).toBeLessThan(LIMITS.maxPayloadBytes)
    engine.dispose()
  })

  it('validates rule objects in isolation', () => {
    expect(ruleSchema.safeParse({ id: 'r', source: 'in0', target: 'out1', mode: 'above', threshold: 50 }).success).toBe(true)
    expect(ruleSchema.safeParse({ id: 'r', source: 'nope', target: 'out1', mode: 'above', threshold: 50 }).success).toBe(false)
  })
})

describe('snapshot history', () => {
  it('undo/redo restores structure, wiring and water', () => {
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'relay-lab')
    const original = engine.serialize()
    const lamp = engine.simulation.componentList.find((component) => component.type === 'Lamp')
    engine.deleteComponent(lamp.id)
    expect(engine.simulation.componentList.length).toBe(original.nodes.length - 1)
    expect(engine.undo()).toBe(true)
    expect(engine.simulation.componentList.length).toBe(original.nodes.length)
    expect(engine.simulation.edges.length).toBe(original.edges.length)
    expect(engine.redo()).toBe(true)
    expect(engine.simulation.componentList.length).toBe(original.nodes.length - 1)
    engine.dispose()
  })

  it('reset restores the initial scene and its water', () => {
    const engine = new Engine({ canvas: null })
    buildDemo(engine, 'proximity-pump')
    const before = serializeScene(engine.simulation)
    for (let i = 0; i < 60 * 5; i++) engine.simulation.step(1 / 60)
    engine.resetScene()
    const after = serializeScene(engine.simulation)
    expect(after.nodes.length).toBe(before.nodes.length)
    expect(after.edges.length).toBe(before.edges.length)
    expect(after.fluid.length).toBe(before.fluid.length)
    expect(engine.simulation.fluid.count).toBe(150)
    engine.dispose()
  })
})
