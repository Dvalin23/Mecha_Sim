import { Simulation } from './Simulation.js'
import { createComponent, componentTypes, getComponentClass } from './registry.js'
import { Vec2 } from './math/Vec2.js'
import { shortId, uuid } from './ids.js'

/**
 * Serialization layer.
 *
 * A live simulation is a graph of ES6 class instances whose references are
 * mutually cyclic (a relay is wired to a motor, the motor's feedback is wired
 * back to the relay). JSON cannot express that, so the algorithm is:
 *
 *   1. **Pre-process** — walk the entity list (`simulation.componentList`).
 *   2. **Reference stripping** — every node is emitted as a flat object; all
 *      class methods, bodies and pointers are dropped. Object references are
 *      replaced with the target's **UUID string**.
 *   3. **Edge extraction** — the wiring graph is emitted twice: as an explicit
 *      `edges` array (port → port, lossless) *and* as the whitepaper's
 *      `connections` map (output pin → target node) for interoperability.
 *   4. **Reconstruction** — `deserializeProject()` looks up each node's ES6
 *      class in the registry by its `type` field, re-instantiates it with the
 *      stored properties, then rebuilds the `connections` map from the saved
 *      UUIDs *before* the first `step()` runs.
 *
 * Runtime `state` is saved too (relay contact position, switch state, emitted
 * droplet count) so a shared link reopens the exact circuit, not a reset one.
 */
export const PROJECT_FORMAT_VERSION = 3
export const UNITS = { pixelsPerMetre: 100, gravityMps2: 9.81 }

export const emptyProject = (name = 'Untitled Simulation') => ({
  formatVersion: PROJECT_FORMAT_VERSION,
  simulationId: `sim_${shortId(8)}`,
  name,
  description: '',
  createdAt: new Date().toISOString(),
  environment: {
    gravity: 981,
    gravityMetersPerSecondSquared: UNITS.gravityMps2,
    pixelsPerMetre: UNITS.pixelsPerMetre,
    timestep: 1 / 60,
    bounds: { width: 1600, height: 900 },
  },
  nodes: [],
  edges: [],
  fluid: { maxParticles: 260, radius: 5, particles: [] },
})

/** Flat, reference-free representation of one component. */
export function serializeNode(component, simulation) {
  const node = component.serialize()
  // Reference stripping: object pointers → UUID strings.
  const connections = {}
  for (const edge of simulation.outgoing(component.id)) {
    const previous = connections[edge.from.port]
    if (previous) {
      // Fan-out from one pin is legal; keep it representable in a map.
      connections[edge.from.port] = [].concat(previous, {
        node: edge.to.node,
        port: edge.to.port,
      })
    } else {
      connections[edge.from.port] = { node: edge.to.node, port: edge.to.port }
    }
  }
  node.connections = connections
  return node
}

export function serializeScene(simulation) {
  return {
    nodes: simulation.componentList.map((component) => serializeNode(component, simulation)),
    edges: simulation.edges.map((edge) => ({
      id: edge.id,
      from: { ...edge.from },
      to: { ...edge.to },
      kind: edge.kind,
    })),
  }
}

export function serializeProject(simulation, meta = {}) {
  const scene = serializeScene(simulation)
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    simulationId: meta.simulationId ?? simulation.id,
    name: meta.name ?? simulation.name,
    description: meta.description ?? '',
    createdAt: meta.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    environment: {
      gravity: simulation.gravity,
      gravityMetersPerSecondSquared: round(simulation.gravity / UNITS.pixelsPerMetre, 3),
      pixelsPerMetre: UNITS.pixelsPerMetre,
      timestep: simulation.timestep,
      bounds: { ...simulation.bounds },
    },
    nodes: scene.nodes,
    edges: scene.edges,
    fluid: simulation.fluid.serialize(),
    meta: {
      componentCount: scene.nodes.length,
      wireCount: scene.edges.length,
      snapshotSequence: simulation._sequence,
      ...meta,
    },
  }
}

/**
 * Migrate older payloads to the current format.
 * v1 = the whitepaper's simplified example (`connections: { outputPin: "node_02" }`).
 */
export function upgradePayload(payload) {
  const formatVersion = payload.formatVersion ?? 1
  const migrated = { ...payload, formatVersion: PROJECT_FORMAT_VERSION }
  if (formatVersion < 2) {
    // v1 has no edges array: rebuild it from the connections map.
    const edges = []
    for (const node of payload.nodes ?? []) {
      for (const [port, target] of Object.entries(node.connections ?? {})) {
        const targets = Array.isArray(target) ? target : [target]
        for (const t of targets) {
          if (typeof t === 'string') {
            edges.push({ id: uuid(), from: { node: node.id, port }, to: { node: t, port: guessInputPort(payload, t) }, kind: 'digital' })
          } else if (t && typeof t === 'object') {
            edges.push({ id: uuid(), from: { node: node.id, port }, to: { node: t.node, port: t.port ?? guessInputPort(payload, t.node) }, kind: 'digital' })
          }
        }
      }
    }
    migrated.edges = payload.edges ?? edges
    migrated.environment = {
      gravity: 981,
      timestep: 1 / 60,
      bounds: { width: 1600, height: 900 },
      ...(payload.environment ?? {}),
    }
  }
  if (formatVersion < 3) {
    // v2 stored a single `connections` map and no fluid block.
    migrated.edges = payload.edges ?? []
    migrated.fluid = payload.fluid ?? { maxParticles: 260, radius: 5, particles: [] }
  }
  return migrated
}

function guessInputPort(payload, nodeId) {
  const node = (payload.nodes ?? []).find((n) => n.id === nodeId)
  const Ctor = node ? getComponentClass(node.type) : null
  return Ctor?.ports?.inputs?.[0]?.id ?? 'in0'
}

/**
 * Instantiate a scene into an existing (or brand-new) simulation.
 * This is the "deserialize()" half of the pipeline.
 */
export function restoreScene(simulation, scene, { silent = false } = {}) {
  const nodes = scene.nodes ?? []
  const idMap = new Map()

  for (const node of nodes) {
    const Ctor = getComponentClass(node.type)
    if (!Ctor) {
      console.warn(`[MechaSim] skipping unknown component type "${node.type}"`)
      continue
    }
    const component = createComponent(node.type, {
      id: node.id,
      position: new Vec2(node.x ?? 0, node.y ?? 0),
      rotation: node.rotation ?? 0,
      properties: node.properties ?? {},
      state: node.state ?? {},
    })
    // Preserve transient-but-meaningful runtime state across a reload.
    if (node.state) {
      component.state = { ...component.state, ...deepClone(node.state) }
    }
    simulation.add(component, { silent: true })
    idMap.set(node.id, component)
  }

  // Rebuild the connections map from the stored UUID strings.
  const edges = scene.edges ?? []
  for (const edge of edges) {
    if (!idMap.has(edge.from?.node) || !idMap.has(edge.to?.node)) continue
    try {
      simulation.connect(edge.from.node, edge.from.port, edge.to.node, edge.to.port, { silent: true })
    } catch (error) {
      console.warn(`[MechaSim] dropped invalid wire: ${error.message}`)
    }
  }

  if (scene.fluid?.particles?.length) {
    simulation.fluid.deserialize(scene.fluid)
  }
  if (!silent) simulation.emit('scene:restored', { nodes: idMap.size, edges: edges.length })
  simulation._scheduleDirty = true
  return simulation
}

/** Build a complete Simulation from a stored payload. */
export function deserializeProject(payload, options = {}) {
  const upgraded = upgradePayload(payload)
  const env = upgraded.environment ?? {}
  const simulation = new Simulation({
    id: upgraded.simulationId || `sim_${shortId(8)}`,
    name: upgraded.name ?? options.name ?? 'Shared project',
    gravity: env.gravity ?? 981,
    timestep: env.timestep ?? 1 / 60,
    bounds: env.bounds ?? { width: 1600, height: 900 },
    fluid: upgraded.fluid ?? options.fluid,
  })
  restoreScene(simulation, upgraded, options)
  return simulation
}

/** Structural validation independent of the transport (used by tests). */
export function validatePayloadShape(payload) {
  const errors = []
  if (!payload || typeof payload !== 'object') return { ok: false, errors: ['payload is not an object'] }
  if (!Array.isArray(payload.nodes)) errors.push('nodes must be an array')
  for (const [index, node] of (payload.nodes ?? []).entries()) {
    if (!node.id) errors.push(`nodes[${index}].id missing`)
    if (!node.type) errors.push(`nodes[${index}].type missing`)
    if (!componentTypes.includes(node.type)) errors.push(`nodes[${index}].type "${node.type}" is not a registered component`)
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) errors.push(`nodes[${index}] has non-finite coordinates`)
  }
  return { ok: errors.length === 0, errors }
}

/** Rough payload size in bytes — the API rejects anything over the cap. */
export function payloadSize(payload) {
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

const round = (value, decimals = 3) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function deepClone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}
