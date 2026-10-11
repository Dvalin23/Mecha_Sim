import { nodeId as makeNodeId } from './ids.js'
import { Vec2 } from './math/Vec2.js'

/**
 * Base class for every virtual device.
 *
 * A component is a *logic* object that owns zero or more {@link RigidBody}
 * instances (its physical presence in the world) plus an I/O port signature.
 * The simulation evaluates components in fixed **phases** each step:
 *
 *   sensor → logic → controller → actuator → display
 *
 * Because a phase reads the *previous* step's values from later phases, a cycle
 * such as `Relay → Motor → Relay` is well-defined (it costs exactly one frame of
 * latency, which is precisely what a real 1 kHz-scanning MCU does). No component
 * can stall the loop by feeding back on itself within a single step.
 *
 * Value kinds:
 *   'digital' — boolean
 *   'analog'  — number
 *   'text'    — string (LCD payloads)
 */
export const PortKind = Object.freeze({
  DIGITAL: 'digital',
  ANALOG: 'analog',
  TEXT: 'text',
})

export const ComponentPhase = Object.freeze({
  SENSOR: 'sensor',
  LOGIC: 'logic',
  CONTROLLER: 'controller',
  ACTUATOR: 'actuator',
  DISPLAY: 'display',
})

/** Neutral value for a port kind — used when nothing is wired into an input. */
export const neutralValue = (kind) =>
  kind === PortKind.DIGITAL ? false : kind === PortKind.TEXT ? '' : 0

export class Component {
  /** @type {string} unique registry key, must match the serialized `type`. */
  static type = 'Component'
  /** Human label shown in the parts palette. */
  static label = 'Component'
  /** Palette grouping. */
  static group = 'Misc'
  static accent = '#38bdf8'
  static icon = '□'
  static description = ''
  static phase = ComponentPhase.LOGIC
  /** Port signature: { inputs: [{id,label,kind}], outputs: [...] } */
  static ports = { inputs: [], outputs: [] }
  /** Numeric/boolean tunables exposed by the React inspector. */
  static controls = []
  /** Extra inspector rows (buttons, transient actions). */
  static actions = []
  /** Default `properties` merged into every instance. */
  static defaults = {}
  /** Does the palette place more than one? */
  static singleton = false

  constructor(options = {}) {
    const {
      id = makeNodeId(this.constructor.type),
      position = new Vec2(0, 0),
      rotation = 0,
      properties = {},
      state = null,
    } = options

    this.id = id
    this.type = this.constructor.type
    this.position = new Vec2(position.x, position.y)
    this.rotation = rotation

    this.properties = {}
    for (const control of this.constructor.controls) {
      this.properties[control.key] = control.default
    }
    Object.assign(this.properties, this.constructor.defaults, properties)

    this.state = { ...(state ?? {}) }
    this.simulation = null
    /** @type {import('./physics/RigidBody.js').RigidBody[]} */
    this.bodies = []
    /** Live port values, refreshed by the simulation each step. */
    this.inputValues = {}
    this.outputValues = {}
    for (const port of this.ports.inputs) {
      this.inputValues[port.id] = neutralValue(port.kind)
    }
    for (const port of this.ports.outputs) {
      this.outputValues[port.id] = neutralValue(port.kind)
    }
    this.enabled = true
    this.selected = false
    this.hovered = false
    this.warn = null
  }

  get ports() {
    return this.constructor.ports
  }

  /** The physics world this component lives in (shorthand for the hot paths). */
  get world() {
    return this.simulation.world
  }

  /** Simulation clock in seconds. */
  get time() {
    return this.simulation?.world?.time ?? 0
  }

  /** The fluid particle system (pumps, valves, tanks). */
  get fluid() {
    return this.simulation.fluid
  }

  get accent() {
    return this.constructor.accent
  }

  get label() {
    return this.constructor.label
  }

  /** Called by the simulation right after instantiation. */
  attach(simulation) {
    this.simulation = simulation
    this.initialize()
    return this
  }

  /** Build bodies / initial internal state. Runs once per instance. */
  initialize() {}

  /** @param {number} dt fixed timestep in seconds @param {object} ctx simulation context */
  update(/* dt, ctx */) {}

  /** Fired when the user edits a property in the inspector. */
  onPropertyChanged(key, value) {
    this.properties[key] = value
    this.handlePropertyChange(key, value)
  }

  handlePropertyChange(/* key, value */) {}

  /** Read the value of an input port (already resolved by the simulation). */
  readInput(portId) {
    const port = this.ports.inputs.find((p) => p.id === portId)
    const value = this.inputValues[portId]
    if (!port) return value
    return value === undefined ? neutralValue(port.kind) : value
  }

  /** Write an output port value. */
  writeOutput(portId, value) {
    this.outputValues[portId] = value
    return value
  }

  /**
   * Digital *inhibit* pin with an internal pull-up: an unconnected pin reads as
   * enabled (exactly like a microcontroller's INPUT_PULLUP), and only an
   * explicit LOW from a wired source turns the device off.
   */
  readEnable(portId, defaultValue = true) {
    if (!this.simulation?.incoming(this.id, portId).length) return defaultValue
    return this.readInput(portId) === true
  }

  /** True when anything is wired into this input pin. */
  isWired(portId) {
    return (this.simulation?.incoming(this.id, portId).length ?? 0) > 0
  }

  getPosition() {
    return this.position
  }

  /** Move the component and everything it owns. */
  setPosition(x, y) {
    const dx = x - this.position.x
    const dy = y - this.position.y
    this.position.set(x, y)
    for (const body of this.bodies) {
      if (body.isStatic) body.translate(dx, dy)
      else body.setPosition(body.position.x + dx, body.position.y + dy)
    }
    return this
  }

  setRotation(angle) {
    const delta = angle - this.rotation
    this.rotation = angle
    for (const body of this.bodies) {
      if (body.isStatic) body.setAngle(body.angle + delta)
      else body.setAngle(body.angle + delta)
    }
    return this
  }

  /** Axis-aligned bounds for culling, selection outlines and region queries. */
  getBounds() {
    if (!this.bodies.length) {
      return { minX: this.position.x - 24, minY: this.position.y - 24, maxX: this.position.x + 24, maxY: this.position.y + 24 }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const body of this.bodies) {
      minX = Math.min(minX, body.aabb.minX)
      minY = Math.min(minY, body.aabb.minY)
      maxX = Math.max(maxX, body.aabb.maxX)
      maxY = Math.max(maxY, body.aabb.maxY)
    }
    return { minX, minY, maxX, maxY }
  }

  /** True if a world-space point lands on this component (used for picking). */
  hitTest(x, y, padding = 6) {
    for (const body of this.bodies) {
      if (body.containsPoint({ x, y })) return true
    }
    const b = this.getBounds()
    return x >= b.minX - padding && x <= b.maxX + padding && y >= b.minY - padding && y <= b.maxY + padding
  }

  /** Snapshot of the interesting runtime numbers, shown in the HUD/inspector. */
  readState() {
    return this.state
  }

  /** Overlay drawing hook (LCD text, LEDs, debug arcs). */
  drawOverlay(/* ctx, view */) {}

  /** Component-specific mesh drawing (beyond its rigid bodies). */
  draw(/* ctx, view */) {}

  serialize() {
    return {
      id: this.id,
      type: this.type,
      x: round(this.position.x),
      y: round(this.position.y),
      rotation: round(this.rotation, 4),
      properties: { ...this.properties },
      state: this.exportState(),
    }
  }

  exportState() {
    return { ...this.state }
  }

  dispose() {
    for (const body of this.bodies) {
      if (this.simulation) this.simulation.world.removeBody(body)
    }
    this.bodies.length = 0
  }
}

const round = (v, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}
