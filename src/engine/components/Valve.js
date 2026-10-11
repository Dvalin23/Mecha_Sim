import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox, kinematicBox } from './bodyFactory.js'
import { boxShape } from '../physics/shapes.js'
import { Vec2 } from '../math/Vec2.js'
import { drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * Solenoid gate valve.
 *
 * Unlike the Pump (a force field), the Valve is *physically real*: it slides a
 * kinematic gate plate across the flow path. Fluid particles collide with the
 * plate, so "closed" genuinely stops the water — no special-case logic.
 *
 * The actuator has a first-order response (`responseMs`) and reports its
 * openness as an analog output, which is exactly the feedback a real
 * position-sensing valve would give the controller.
 */
export class Valve extends Component {
  static type = 'Valve'
  static label = 'Gate Valve'
  static group = 'Fluid'
  static accent = '#60a5fa'
  static icon = '⋈'
  static description = 'Physically blocks fluid with a sliding gate. Digital open/close plus analog position feedback.'
  static phase = ComponentPhase.ACTUATOR
  static ports = {
    inputs: [
      { id: 'open', label: 'Open', kind: PortKind.DIGITAL },
      { id: 'position', label: 'Position', kind: PortKind.ANALOG },
    ],
    outputs: [
      { id: 'openness', label: 'Openness %', kind: PortKind.ANALOG },
      { id: 'flowing', label: 'Flowing', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'gateWidth', label: 'Gate width', type: 'number', min: 16, max: 300, step: 2, default: 46, unit: 'cm' },
    { key: 'travel', label: 'Gate travel', type: 'number', min: 10, max: 400, step: 2, default: 54, unit: 'cm' },
    { key: 'responseMs', label: 'Actuation time', type: 'number', min: 20, max: 5000, step: 20, default: 600, unit: 'ms' },
    { key: 'normallyOpen', label: 'Normally open', type: 'boolean', default: false },
    { key: 'manual', label: 'Manual override', type: 'number', min: 0, max: 100, step: 1, default: 0, unit: '%' },
  ]
  static probes = [
    { id: 'openness', label: 'Openness', unit: '%', color: '#60a5fa', read: (c) => c.state.openness * 100 },
    { id: 'flow', label: 'Throughput', unit: 'pt', color: '#22d3ee', read: (c) => c.state.throughput },
  ]

  initialize() {
    // The valve *body* is drawn, not simulated. A 46×30 collider centred on the
    // mount sits in the flow path of any gate mounted near a floor, and was
    // measured acting as a dam (a pile of droplets bridged on it and stopped
    // draining). Making it decorative leaves exactly one collider — the plate —
    // which is what should decide the hydraulics.
    const housing = null
    this.housing = housing

    const plate = kinematicBox({
      x: this.position.x,
      y: this.position.y,
      width: 12,
      height: this.properties.gateWidth,
      angle: this.rotation,
      tag: 'gate',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.plate = plate
    this.bodies = [plate]
    this._base = new Vec2(this.position.x, this.position.y)
    this.state = { ...this.state, openness: this.properties.normallyOpen ? 1 : 0, throughput: 0, flowing: false }
    this.applyGatePosition()
  }

  /** Gate plate offset: slides out of the flow path as the valve opens. */
  applyGatePosition() {
    const travel = this.properties.travel
    const openness = clamp(this.state.openness, 0, 1)
    // Local −y is "up" in the component's frame; the plate retracts upward.
    const upX = Math.sin(this.rotation)
    const upY = -Math.cos(this.rotation)
    this.plate.setPosition(
      this._base.x + upX * travel * openness,
      this._base.y + upY * travel * openness,
    )
    // Kinematic bodies only move by position; keep their velocity zero so they
    // do not inject energy into contacts.
    this.plate.velocity.set(0, 0)
    this.plate.angularVelocity = 0
  }

  setPosition(x, y) {
    super.setPosition(x, y)
    this._base.set(this.position.x, this.position.y)
    this.applyGatePosition()
    return this
  }

  /** Gate width changes rebuild the collider (and default the travel to match). */
  handlePropertyChange(key, value) {
    if (key === 'gateWidth') {
      this.plate.setShape(boxShape(12, value))
      this.plate.syncTransform(true)
      this.applyGatePosition()
    }
    if (key === 'travel') this.applyGatePosition()
  }

  update(dt) {
    const props = this.properties
    const manual = clamp(props.manual / 100, 0, 1)
    const command = props.manual > 0 ? manual : this.readInput('open') === true ? 1 : props.normallyOpen ? 1 : 0
    const alpha = rcAlpha(dt, Math.max(props.responseMs, 1) / 1000)
    const next = ema(this.state.openness, command, alpha)
    const moved = Math.abs(next - this.state.openness) > 1e-5
    this.state.openness = next

    const positionInput = Number(this.readInput('position'))
    if (Number.isFinite(positionInput) && this.simulation.incoming(this.id, 'position').length) {
      const alpha2 = rcAlpha(dt, Math.max(props.responseMs, 1) / 1000)
      this.state.openness = ema(this.state.openness, clamp(positionInput / 100, 0, 1), alpha2)
      this.state.openness = clamp(this.state.openness, 0, 1)
    }

    this.applyGatePosition()

    // Throughput: how much fluid is passing the gate plane right now.
    const plane = this.plate.position
    const box = {
      minX: plane.x - 60,
      minY: plane.y - 60,
      maxX: plane.x + 60,
      maxY: plane.y + 60,
    }
    const { count } = this.fluid.measureVolume(box.minX, box.minY, box.maxX, box.maxY)
    this.state.throughput = count
    this.state.flowing = count > 0 && this.state.openness > 0.15

    this.writeOutput('openness', Math.round(this.state.openness * 1000) / 10)
    this.writeOutput('flowing', this.state.flowing)
  }

  readState() {
    return {
      Gate: `${(this.state.openness * 100).toFixed(0)}% open`,
      Command: this.readInput('open') === true ? 'OPEN' : this.properties.normallyOpen ? 'normally open' : 'CLOSED',
      'Nearby fluid': `${this.state.throughput} particles`,
    }
  }

  draw(ctx) {
    const { position: p, rotation } = this
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.roundRect?.(-23, -15, 46, 30, 4) ?? ctx.rect(-23, -15, 46, 30)
    ctx.fillStyle = '#101d33'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.5
    ctx.stroke()
    // bonnet
    ctx.beginPath()
    ctx.rect(-9, -30, 18, 16)
    ctx.fillStyle = '#16263f'
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    // Gate plate (kinematic body position drives the visual)
    ctx.save()
    ctx.translate(this.plate.position.x, this.plate.position.y)
    ctx.rotate(this.rotation)
    const gateWidth = this.properties.gateWidth
    ctx.beginPath()
    ctx.rect(-6, -gateWidth / 2, 12, gateWidth)
    const open = this.state.openness
    ctx.fillStyle = open > 0.85 ? 'rgba(96,165,250,0.25)' : 'rgba(96,165,250,0.75)'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.4
    ctx.stroke()
    ctx.restore()

    if (this.selected || this.hovered) {
      drawTag(ctx, p.x, p.y - 44, `gate ${(this.state.openness * 100).toFixed(0)}%`, { color: '#bfdbfe' })
    }
  }
}
