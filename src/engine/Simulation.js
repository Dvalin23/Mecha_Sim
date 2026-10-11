import { World } from './physics/World.js'
import { FluidSystem } from './FluidSystem.js'
import { ComponentPhase, neutralValue } from './Component.js'
import { uuid } from './ids.js'
import { Vec2 } from './math/Vec2.js'

/** Evaluation order of the mechatronic layer. Lower runs first. */
const PHASE_ORDER = [
  ComponentPhase.SENSOR,
  ComponentPhase.LOGIC,
  ComponentPhase.CONTROLLER,
  ComponentPhase.ACTUATOR,
  ComponentPhase.DISPLAY,
]

/**
 * Lightweight synchronous event emitter (the engine has no framework
 * dependency, so it ships its own 30-line bus).
 */
export class Emitter {
  constructor() {
    this._listeners = new Map()
  }

  on(event, listener) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(listener)
    return () => this.off(event, listener)
  }

  off(event, listener) {
    this._listeners.get(event)?.delete(listener)
  }

  emit(event, payload) {
    const set = this._listeners.get(event)
    if (!set) return
    for (const listener of set) listener(payload)
  }

  clear() {
    this._listeners.clear()
  }
}

/**
 * Simulation — the scene: a physics world plus a netlist of components.
 *
 * It is deliberately framework-agnostic. React owns zero of this state; it only
 * holds references and pushes mutations through the methods below.
 */
export class Simulation extends Emitter {
  constructor(options = {}) {
    super()
    const {
      id = uuid(),
      name = 'Untitled Simulation',
      gravity = 981,
      timestep = 1 / 60,
      bounds = { width: 1600, height: 900 },
      solver = {},
      fluid = {},
    } = options

    this.id = id
    this.name = name
    this.timestep = timestep
    this.gravity = gravity
    this.bounds = { minX: 0, minY: 0, ...bounds }

    this.world = new World({ gravity, fixedDt: timestep, bounds: this.bounds, solver })
    this.fluid = new FluidSystem(this.world, fluid)

    /** @type {Map<string, import('./Component.js').Component>} */
    this.components = new Map()
    /** @type {Array<{id, from:{node,port}, to:{node,port}, kind}}> */
    this.edges = []
    this._schedule = []
    this._scheduleDirty = true
    this._sequence = 0
    this.sampleCount = 0

    /** Ring buffers for the oscilloscope, keyed `${nodeId}:${port}`. */
    this.traces = new Map()

    this.world.onBeginContact((a, b) => {
      this.emit('contact', { a, b })
    })
  }

  get componentList() {
    return [...this.components.values()]
  }

  get(name) {
    return this.components.get(name) ?? null
  }

  // --- mutation -----------------------------------------------------------
  add(component, { silent = false } = {}) {
    if (this.components.has(component.id)) {
      throw new Error(`Duplicate component id "${component.id}"`)
    }
    component.attach(this)
    for (const body of component.bodies) {
      if (!body.userData) body.userData = { componentId: component.id, componentType: component.type }
      if (!this.world.bodies.includes(body)) this.world.addBody(body)
    }
    this.components.set(component.id, component)
    this._scheduleDirty = true
    if (!silent) this.emit('component:added', component)
    return component
  }

  remove(componentOrId) {
    const component =
      typeof componentOrId === 'string' ? this.components.get(componentOrId) : componentOrId
    if (!component) return false
    component.dispose()
    this.components.delete(component.id)
    this.edges = this.edges.filter(
      (edge) => edge.from.node !== component.id && edge.to.node !== component.id,
    )
    this._scheduleDirty = true
    this.emit('component:removed', component)
    return true
  }

  /**
   * Wire an output port to an input port.
   * Rejects incompatible kinds (digital → text) and self-loops.
   */
  connect(fromNode, fromPort, toNode, toPort, { silent = false } = {}) {
    const source = this.components.get(fromNode)
    const target = this.components.get(toNode)
    if (!source || !target) throw new Error('Cannot wire: unknown node id')
    if (fromNode === toNode) throw new Error('Cannot wire a component to itself')
    const outPort = source.ports.outputs.find((p) => p.id === fromPort)
    const inPort = target.ports.inputs.find((p) => p.id === toPort)
    if (!outPort) throw new Error(`"${source.label}" has no output "${fromPort}"`)
    if (!inPort) throw new Error(`"${target.label}" has no input "${toPort}"`)

    const existing = this.edges.find(
      (e) =>
        e.from.node === fromNode &&
        e.from.port === fromPort &&
        e.to.node === toNode &&
        e.to.port === toPort,
    )
    if (existing) return existing

    // An input pin accepts a single driver, like real hardware.
    const conflicting = this.edges.filter((e) => e.to.node === toNode && e.to.port === toPort)
    for (const edge of conflicting) this.disconnect(edge.id, { silent: true })

    const edge = {
      id: uuid(),
      from: { node: fromNode, port: fromPort },
      to: { node: toNode, port: toPort },
      kind: inPort.kind,
    }
    this.edges.push(edge)
    if (!silent) this.emit('wire:added', edge)
    return edge
  }

  disconnect(edgeId, { silent = false } = {}) {
    const index = this.edges.findIndex((e) => e.id === edgeId)
    if (index < 0) return false
    const [edge] = this.edges.splice(index, 1)
    if (!silent) this.emit('wire:removed', edge)
    return true
  }

  /** Every edge feeding a given input port. */
  incoming(nodeId, portId) {
    return this.edges.filter((e) => e.to.node === nodeId && (portId ? e.to.port === portId : true))
  }

  outgoing(nodeId, portId) {
    return this.edges.filter((e) => e.from.node === nodeId && (portId ? e.from.port === portId : true))
  }

  // --- evaluation schedule ------------------------------------------------
  get schedule() {
    if (this._scheduleDirty) {
      this._schedule = [...this.components.values()].sort((a, b) => {
        const pa = PHASE_ORDER.indexOf(a.constructor.phase)
        const pb = PHASE_ORDER.indexOf(b.constructor.phase)
        if (pa !== pb) return pa - pb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      this._scheduleDirty = false
    }
    return this._schedule
  }

  /** Pull an input's value across the netlist (with one-frame phase latency). */
  resolveInputs(component) {
    for (const port of component.ports.inputs) {
      const edge = this.edges.find((e) => e.to.node === component.id && e.to.port === port.id)
      if (!edge) {
        component.inputValues[port.id] = neutralValue(port.kind)
        continue
      }
      const source = this.components.get(edge.from.node)
      if (!source || !source.enabled) {
        component.inputValues[port.id] = neutralValue(port.kind)
        continue
      }
      const value = source.outputValues[edge.from.port]
      component.inputValues[port.id] = value === undefined ? neutralValue(port.kind) : value
    }
  }

  // --- the fixed step -----------------------------------------------------
  /**
   * One deterministic simulation tick. Never called from the render loop
   * directly: the engine's accumulator decides *how many* of these run.
   */
  step(dt = this.timestep) {
    this.world.step(dt)
    this._sequence++
    this.sampleCount++

    const ctx = { dt, simulation: this, world: this.world, fluid: this.fluid, sequence: this._sequence }
    for (const component of this.schedule) {
      if (!component.enabled) continue
      this.resolveInputs(component)
      component.update(dt, ctx)
    }

    this.fluid.cullOutside(this.worldBoundsExpanded)
    if (this._sequence % 2 === 0) this.sampleTraces()
    return this
  }

  get worldBoundsExpanded() {
    return {
      minX: -600,
      minY: -600,
      maxX: this.bounds.width + 600,
      maxY: this.bounds.height + 600,
    }
  }

  /** Record probe values for the oscilloscope (round-robin over traces). */
  sampleTraces() {
    for (const component of this.components.values()) {
      for (const probe of component.constructor.probes ?? []) {
        const key = `${component.id}:${probe.id}`
        let trace = this.traces.get(key)
        if (!trace) {
          trace = { key, nodeId: component.id, label: probe.label, unit: probe.unit, color: probe.color, data: new Float32Array(240), length: 0, head: 0 }
          this.traces.set(key, trace)
        }
        const value = probe.read(component)
        trace.data[trace.head] = Number.isFinite(value) ? value : 0
        trace.head = (trace.head + 1) % trace.data.length
        trace.length = Math.min(trace.length + 1, trace.data.length)
      }
    }
  }

  /** Ordered oldest → newest samples for a probe. */
  readTrace(key) {
    const trace = this.traces.get(key)
    if (!trace) return null
    const out = new Array(trace.length)
    const size = trace.data.length
    const start = (trace.head - trace.length + size) % size
    for (let i = 0; i < trace.length; i++) out[i] = trace.data[(start + i) % size]
    return { ...trace, samples: out }
  }

  // --- whole-scene operations --------------------------------------------
  reset() {
    this.world.clear()
    this.fluid.clear()
    this.fluid = new FluidSystem(this.world, {})
    this.traces.clear()
    const snapshot = this.componentList.map((c) => c.serialize())
    // Rebuild every component from its serialized form (restores initial state).
    this.components.clear()
    this.edges = []
    this._scheduleDirty = true
    this._rebuilding = []
    return snapshot
  }

  get stats() {
    return {
      ...this.world.getStats(),
      components: this.components.size,
      wires: this.edges.length,
      fluid: this.fluid.count,
      sequence: this._sequence,
    }
  }

  /** Hit-test components in reverse creation order (topmost first). */
  pick(x, y) {
    const list = this.componentList
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hitTest(x, y)) return list[i]
    }
    return null
  }

  /** Component owning a rigid body (used by contact events / debug overlay). */
  componentOfBody(body) {
    if (!body) return null
    if (body.userData?.componentId) return this.components.get(body.userData.componentId) ?? null
    return null
  }

  /** Bodies that are not owned by a component (level geometry, fluid). */
  get orphanBodies() {
    return this.world.bodies.filter((b) => !b.userData?.componentId && !b.isFluid)
  }

  findBodyById(id) {
    return this.world.bodies.find((b) => b.id === id) ?? null
  }

  gravityVector() {
    return new Vec2(0, this.gravity)
  }

  setGravity(value) {
    this.gravity = value
    this.world.gravity.set(0, value)
    this.world.wakeAll()
    this.emit('environment:changed', { gravity: value })
  }
}
