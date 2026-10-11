import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox, rotor } from './bodyFactory.js'
import { MotorJoint } from '../physics/Joints.js'
import { drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * DC gear motor with a physical rotor.
 *
 * The electrical side is a percentage command; the mechanical side is a real
 * rigid body driven by a {@link MotorJoint} PD controller:
 *
 *     τ = k_p·(ω_target − ω)   clamped to ±maxTorque
 *
 * Because the rotor is a rigid body, it participates in collisions — mount a
 * paddle on it and it will genuinely fling crates across the map.
 */
export class Motor extends Component {
  static type = 'Motor'
  static label = 'Gear Motor'
  static group = 'Actuators'
  static accent = '#fbbf24'
  static icon = '◍'
  static description = 'Turns a physical rotor through a torque-limited servo joint. Direction and speed inputs.'
  static phase = ComponentPhase.ACTUATOR
  static ports = {
    inputs: [
      { id: 'power', label: 'Power', kind: PortKind.DIGITAL },
      { id: 'speed', label: 'Speed', kind: PortKind.ANALOG },
      { id: 'direction', label: 'Direction', kind: PortKind.DIGITAL },
    ],
    outputs: [
      { id: 'rpm', label: 'RPM', kind: PortKind.ANALOG },
      { id: 'angle', label: 'Angle', kind: PortKind.ANALOG },
    ],
  }
  static controls = [
    { key: 'maxRpm', label: 'Rated speed', type: 'number', min: 10, max: 760, step: 10, default: 240, unit: 'rpm' },
    { key: 'torque', label: 'Max torque', type: 'number', min: 100, max: 200000, step: 100, default: 26000, unit: 'N·cm' },
    { key: 'responseMs', label: 'Response', type: 'number', min: 20, max: 3000, step: 20, default: 420, unit: 'ms' },
    { key: 'radius', label: 'Rotor radius', type: 'number', min: 8, max: 90, step: 1, default: 22, unit: 'cm' },
    { key: 'mount', label: 'Mount', type: 'select', default: 'base', options: [
      { value: 'base', label: 'Bolted base' },
      { value: 'floating', label: 'Floating (spring tether)' },
    ] },
  ]
  static probes = [
    { id: 'rpm', label: 'Rotor', unit: 'rpm', color: '#fbbf24', read: (c) => c.state.rpm },
    { id: 'torque', label: 'Torque', unit: 'N·cm', color: '#fb923c', read: (c) => c.state.torque },
  ]

  initialize() {
    const housing = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 58,
      height: 46,
      angle: this.rotation,
      tag: 'actuator',
      material: 'metal',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.housing = housing

    const shaftOffset = 46
    const shaftX = this.position.x + Math.cos(this.rotation) * shaftOffset
    const shaftY = this.position.y + Math.sin(this.rotation) * shaftOffset
    const wheel = rotor({
      x: shaftX,
      y: shaftY,
      radius: this.properties.radius,
      mass: 1.4,
      tag: 'rotor',
      sides: 16,
      userData: { componentId: this.id, componentType: this.type },
    })
    this.rotor = wheel
    this.motorJoint = new MotorJoint(housing, wheel, {
      maxTorque: this.properties.torque * 0.01,
      stiffness: 18,
      damping: 5,
      targetSpeed: 0,
    })
    this.bodies = [housing, wheel]
    this._previousAngle = wheel.angle
    this.state = { ...this.state, rpm: 0, torque: 0, angle: wheel.angle, direction: 1, running: false }
  }

  attach(simulation) {
    super.attach(simulation)
    this.simulation.world.addJoint(this.motorJoint)
    return this
  }

  handlePropertyChange(key, value) {
    if (key === 'radius' && this.rotor) {
      // Rebuild the rotor geometry so the visual and the collider stay in sync.
      this.rotor.shape.radius = value
      this.rotor.shape.setVertices(regularVerts(value, 16))
      this.rotor.computeMassFrom(this.rotor.mass)
    }
    if (key === 'torque') this.motorJoint.maxTorque = value * 0.01
  }

  update(dt) {
    const props = this.properties
    const powered = this.readInput('power') === true
    const speedInput = Number(this.readInput('speed'))
    const direction = this.readInput('direction') === true ? -1 : 1
    const throttle = this.isWired('speed') ? clamp(speedInput / 100, 0, 1) : 1
    const targetRpm = powered ? props.maxRpm * throttle * direction : 0

    const alpha = rcAlpha(dt, Math.max(props.responseMs, 1) / 1000)
    this.state.rpm = ema(this.state.rpm, targetRpm, alpha)

    // ω (rad/s) = rpm · 2π / 60. The joint works in the engine's angular units.
    this.motorJoint.targetSpeed = (this.state.rpm / 60) * Math.PI * 2
    this.motorJoint.maxTorque = props.torque * 0.01

    // Measure the rotor rather than trusting the command — this is the load
    // response the inspector shows.
    const measuredRpm = (this.rotor.angularVelocity / (Math.PI * 2)) * 60
    this.state.torque = Math.abs(this.motorJoint.lastError) * this.motorJoint.damping
    this.state.running = Math.abs(measuredRpm) > 1
    this.state.angle = this.rotor.angle
    this.state.direction = direction

    this.writeOutput('rpm', Math.round(measuredRpm * 10) / 10)
    this.writeOutput('angle', Math.round(((this.rotor.angle % (Math.PI * 2)) * 180) / Math.PI))
  }

  readState() {
    return {
      State: this.state.running ? 'RUNNING' : 'idle',
      'Rotor': `${this.state.rpm.toFixed(1)} rpm`,
      Direction: this.state.direction < 0 ? 'reverse' : 'forward',
      'Shaft angle': `${(((this.state.angle % (Math.PI * 2)) * 180) / Math.PI).toFixed(0)}°`,
    }
  }

  draw(ctx) {
    const { position: p } = this
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(this.rotation)
    ctx.beginPath()
    ctx.roundRect?.(-29, -23, 58, 46, 6) ?? ctx.rect(-29, -23, 58, 46)
    ctx.fillStyle = '#241d0f'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(46, 0)
    ctx.strokeStyle = 'rgba(251,191,36,0.55)'
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.restore()

    // Rotor + spokes (physics-driven rotation)
    const r = this.rotor
    ctx.save()
    ctx.translate(r.position.x, r.position.y)
    ctx.rotate(r.angle)
    ctx.beginPath()
    ctx.arc(0, 0, this.properties.radius, 0, Math.PI * 2)
    ctx.fillStyle = '#1c2433'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.strokeStyle = this.state.running ? '#fde68a' : '#64748b'
    ctx.lineWidth = 2.2
    for (let i = 0; i < 6; i++) {
      ctx.save()
      ctx.rotate((i / 6) * Math.PI * 2)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, -this.properties.radius + 3)
      ctx.stroke()
      ctx.restore()
    }
    ctx.beginPath()
    ctx.arc(0, 0, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#fbbf24'
    ctx.fill()
    ctx.restore()

    if (this.selected || this.hovered || this.state.running) {
      drawTag(ctx, p.x, p.y - 34, `${this.state.rpm.toFixed(0)} rpm`, { color: '#fde68a' })
    }
  }
}

function regularVerts(radius, sides) {
  const out = []
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2
    out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius })
  }
  return out
}
