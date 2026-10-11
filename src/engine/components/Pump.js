import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox, rotor } from './bodyFactory.js'
import { MotorJoint } from '../physics/Joints.js'
import { Vec2 } from '../math/Vec2.js'
import { drawTag } from '../draw/gizmo.js'
import { clamp, rcAlpha, ema } from '../math/utils.js'

/**
 * Centrifugal pump.
 *
 * Electrically it is a switch: `power` HIGH → running. Physically it is an
 * impeller with a mouth and a delivery: water inside `radius * 0.25` of the
 * nozzle is taken in (nearest first) and thrown along the nozzle's axis at
 *
 *     v = √(2 · strength · eyeRadius)          — capped at `maxJetSpeed`
 *
 * which is the ejection speed that makes `strength` behave like an acceleration
 * rather than a vague push. Everything else in the `radius` feels a gentle
 * inward draw that refills the eye but can never hold water up against gravity.
 * `launchAngle` tilts the throw off the nozzle's own axis, so a pump can be aimed
 * at a chute or a tank instead of being limited to the direction it is mounted
 * in; intake and launch are documented in `FluidSystem.applyIntake`.
 *
 * The `spinUpMs` time constant is a first-order lag on the impeller speed, so
 * the pump ramps exactly like a motor with inertia — which is what gives the
 * classic "pump overshoots the setpoint" behaviour when paired with a relay
 * that has no hysteresis.
 */
export class Pump extends Component {
  static type = 'Pump'
  static label = 'Water Pump'
  static group = 'Actuators'
  static accent = '#22d3ee'
  static icon = '⌾'
  static description = 'Drives fluid particles with a velocity field. Analog flow rate, digital power input.'
  static phase = ComponentPhase.ACTUATOR
  static ports = {
    inputs: [
      { id: 'power', label: 'Power', kind: PortKind.DIGITAL },
      { id: 'throttle', label: 'Throttle', kind: PortKind.ANALOG },
    ],
    outputs: [
      { id: 'flow', label: 'Flow', kind: PortKind.ANALOG },
      { id: 'running', label: 'Running', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'strength', label: 'Draft accel', type: 'number', min: 0, max: 6000, step: 50, default: 1800, unit: 'cm/s²' },
    { key: 'radius', label: 'Draft radius', type: 'number', min: 30, max: 500, step: 10, default: 200, unit: 'cm' },
    { key: 'swirl', label: 'Swirl', type: 'number', min: -2000, max: 2000, step: 20, default: 200, unit: 'cm/s²' },
    { key: 'launchAngle', label: 'Launch angle', type: 'number', min: -90, max: 90, step: 1, default: 0, unit: '°' }, // offset from the nozzle axis
    { key: 'spinUpMs', label: 'Spin-up', type: 'number', min: 20, max: 4000, step: 20, default: 420, unit: 'ms' },
    { key: 'maxRpm', label: 'Rated speed', type: 'number', min: 60, max: 760, step: 20, default: 600, unit: 'rpm' },
  ]
  static probes = [
    { id: 'flow', label: 'Flow', unit: 'pt/s', color: '#22d3ee', read: (c) => c.state.flow },
    { id: 'rpm', label: 'Impeller', unit: 'rpm', color: '#38bdf8', read: (c) => c.state.rpm },
    { id: 'particles', label: 'Particles', unit: '', color: '#818cf8', read: (c) => c.state.affected },
  ]

  initialize() {
    const housing = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 74,
      height: 56,
      angle: this.rotation,
      tag: 'actuator',
      material: 'metal',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.housing = housing

    const impeller = rotor({
      x: this.position.x,
      y: this.position.y,
      radius: 18,
      mass: 1.2,
      tag: 'impeller',
      sides: 14,
      userData: { componentId: this.id, componentType: this.type },
    })
    impeller.fixedRotation = false
    impeller.angularDamping = 0.55
    this.impeller = impeller

    // The impeller is driven relative to the (static) housing by a virtual
    // servo — the same MotorJoint the Motor component uses, here as a
    // shaft-speed controller.
    this.motorJoint = new MotorJoint(housing, impeller, {
      maxTorque: 900,
      stiffness: 30,
      damping: 6,
      targetSpeed: 0,
    })
    this.bodies = [housing, impeller]

    this.state = {
      ...this.state,
      rpm: 0,
      flow: 0,
      running: false,
      affected: 0,
      nozzle: this.nozzlePoint,
    }
  }

  get nozzlePoint() {
    const distance = 42
    return new Vec2(
      this.position.x + Math.cos(this.rotation) * distance,
      this.position.y + Math.sin(this.rotation) * distance,
    )
  }

  attach(simulation) {
    super.attach(simulation)
    this.simulation.world.addJoint(this.motorJoint)
    return this
  }

  update(dt) {
    const props = this.properties
    const powered = this.readInput('power') === true
    // An unwired throttle pin means "full speed"; a wired 0 % really does stop
    // the pump (this is what makes a potentiometer a usable speed command).
    const throttle = this.isWired('throttle')
      ? clamp(Number(this.readInput('throttle')) / 100, 0, 1)
      : 1
    const targetRpm = powered ? props.maxRpm * throttle : 0

    const alpha = rcAlpha(dt, Math.max(props.spinUpMs, 1) / 1000)
    this.state.rpm = ema(this.state.rpm, targetRpm, alpha)
    // ω [rad/s] = rpm · 2π / 60 — the impeller really turns at the rated speed.
    this.motorJoint.targetSpeed = (this.state.rpm / 60) * Math.PI * 2

    const load = this.state.rpm / Math.max(props.maxRpm, 1)
    this.state.running = load > 0.02

    if (this.state.running) {
      const direction = this.state.rpm < 0 ? -1 : 1
      const forceDirection = new Vec2(Math.cos(this.rotation), Math.sin(this.rotation)).scale(direction)
      // Draft scales with the load *inside* the model: both the suction and the
      // jet speed fall off as the impeller spins down.
      // The draft scales with the load *inside* the model: both the suction and
      // the jet speed fall off as the impeller spins down. Water leaves along the
      // pump's own axis, tilted by `launchAngle`: 0° is "straight out of the
      // nozzle", +30° tips the jet 30° further round, and a user can aim it at a
      // chute from the inspector.
      this.state.affected = this.fluid.applyIntake(this.nozzlePoint, forceDirection, dt, {
        radius: props.radius,
        strength: props.strength * Math.abs(load),
        swirl: props.swirl * Math.abs(load),
        eyeRadius: props.radius * 0.25,
        launchSlope: this.rotation + (props.launchAngle * Math.PI) / 180,
      })
      this.state.jetSpeed = this.fluid.lastJetSpeed
      this.state.flow = this.state.affected * Math.abs(load)
    } else {
      this.state.affected = 0
      this.state.flow = ema(this.state.flow, 0, 0.25)
    }

    this.state.nozzle = this.nozzlePoint
    this.writeOutput('flow', Math.round(this.state.flow * 10) / 10)
    this.writeOutput('running', this.state.running)
  }

  readState() {
    return {
      State: this.state.running ? 'RUNNING' : 'idle',
      'Impeller': `${this.state.rpm.toFixed(0)} rpm`,
      'Flow': `${this.state.flow.toFixed(1)} pt/s`,
      'In draft': `${this.state.affected} particles`,
      'Throttle': this.simulation.incoming(this.id, 'throttle').length ? 'analog wired' : 'open (100%)',
    }
  }

  exportState() {
    return { ...this.state, nozzle: undefined }
  }

  draw(ctx) {
    const { position: p, rotation } = this
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)

    // Volute housing
    ctx.beginPath()
    ctx.arc(0, 0, 27, 0, Math.PI * 2)
    ctx.fillStyle = '#0f2233'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 2
    ctx.stroke()

    // Outlet nozzle
    ctx.beginPath()
    ctx.moveTo(20, -12)
    ctx.lineTo(48, -18)
    ctx.lineTo(48, -4)
    ctx.lineTo(20, 4)
    ctx.closePath()
    ctx.fillStyle = '#123047'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.4
    ctx.stroke()
    ctx.restore()

    // Impeller (rotated by physics, so it visibly spins up)
    ctx.save()
    ctx.translate(this.impeller.position.x, this.impeller.position.y)
    ctx.rotate(this.impeller.angle)
    ctx.strokeStyle = this.state.running ? '#67e8f9' : '#334e68'
    ctx.lineWidth = 2.4
    for (let i = 0; i < 5; i++) {
      ctx.save()
      ctx.rotate((i / 5) * Math.PI * 2)
      ctx.beginPath()
      ctx.moveTo(3, 0)
      ctx.quadraticCurveTo(11, 4, 16, 0)
      ctx.stroke()
      ctx.restore()
    }
    ctx.beginPath()
    ctx.arc(0, 0, 4, 0, Math.PI * 2)
    ctx.fillStyle = this.state.running ? '#22d3ee' : '#475569'
    ctx.fill()
    ctx.restore()

    // Draft field + flow readout
    if (this.state.running) {
      ctx.save()
      const gradient = ctx.createRadialGradient(
        this.state.nozzle.x,
        this.state.nozzle.y,
        8,
        this.state.nozzle.x,
        this.state.nozzle.y,
        this.properties.radius,
      )
      gradient.addColorStop(0, 'rgba(34,211,238,0.16)')
      gradient.addColorStop(1, 'rgba(34,211,238,0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(this.state.nozzle.x, this.state.nozzle.y, this.properties.radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    if (this.state.running || this.selected || this.hovered) {
      drawTag(ctx, p.x, p.y - 44, `${this.state.rpm.toFixed(0)} rpm · ${this.state.flow.toFixed(1)} pt/s`, {
        color: '#a5f3fc',
      })
    }
  }
}
