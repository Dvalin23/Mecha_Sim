import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { Vec2 } from '../math/Vec2.js'
import { drawTag } from '../draw/gizmo.js'
import { clamp, mulberry32 } from '../math/utils.js'

/**
 * Reservoir / tap — the fluid emitter.
 *
 * Emission is budgeted by a fractional accumulator so `rate` particles per
 * second is honoured exactly regardless of the fixed timestep:
 *
 *     budget += rate · Δt ;  while (budget ≥ 1) { emit(); budget −= 1 }
 *
 * Droplet velocities are seeded from the component's deterministic PRNG, which
 * keeps replays of the same save file bit-identical.
 */
export class WaterSource extends Component {
  static type = 'WaterSource'
  static label = 'Water Source'
  static group = 'Fluid'
  static accent = '#38bdf8'
  static icon = '≋'
  static description = 'Emits fluid particles at a configurable rate and velocity. Toggleable from the inspector.'
  static phase = ComponentPhase.ACTUATOR
  static ports = {
    inputs: [{ id: 'enable', label: 'Enable', kind: PortKind.DIGITAL }],
    outputs: [
      { id: 'emitted', label: 'Emitted', kind: PortKind.ANALOG },
      { id: 'active', label: 'Active', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'rate', label: 'Emission rate', type: 'number', min: 0, max: 120, step: 1, default: 24, unit: 'pt/s' },
    { key: 'speed', label: 'Exit speed', type: 'number', min: 0, max: 800, step: 10, default: 180, unit: 'cm/s' },
    { key: 'spread', label: 'Spread', type: 'number', min: 0, max: 60, step: 1, default: 6, unit: '°' },
    { key: 'nozzleLength', label: 'Nozzle length', type: 'number', min: 10, max: 200, step: 5, default: 40, unit: 'cm' },
    { key: 'manual', label: 'Manual tap open', type: 'boolean', default: false },
  ]
  static probes = [
    { id: 'live', label: 'Live particles', unit: '', color: '#38bdf8', read: (c) => c.state.live },
  ]

  initialize() {
    const body = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 64,
      height: 40,
      angle: this.rotation,
      tag: 'fixture',
      material: 'metal',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.housing = body
    this.bodies = [body]
    this._rand = mulberry32(hash(this.id))
    this.state = { ...this.state, budget: 0, emitted: 0, live: 0, active: false, manual: this.properties.manual }
  }

  get nozzle() {
    const length = this.properties.nozzleLength ?? 40
    return new Vec2(
      this.position.x + Math.cos(this.rotation) * length,
      this.position.y + Math.sin(this.rotation) * length,
    )
  }

  update(dt) {
    const props = this.properties
    const gated = this.readInput('enable')
    // A door-bell style trigger: HIGH emits, LOW stops. An unwired input leaves
    // the tap under manual control so a scene can be poked by hand.
    const active = props.manual || gated === true
    this.state.active = active
    this.state.manual = props.manual

    if (active && props.rate > 0) {
      this.state.budget += props.rate * dt
      let safety = 40
      const nozzle = this.nozzle
      while (this.state.budget >= 1 && safety-- > 0) {
        this.state.budget -= 1
        const jitter = ((this._rand() - 0.5) * props.spread * Math.PI) / 180
        const speed = props.speed * (0.92 + this._rand() * 0.16)
        this.fluid.spawn(
          nozzle.x + (this._rand() - 0.5) * 4,
          nozzle.y + (this._rand() - 0.5) * 4,
          Math.cos(this.rotation + jitter) * speed,
          Math.sin(this.rotation + jitter) * speed,
        )
        this.state.emitted++
      }
    } else {
      this.state.budget = clamp(this.state.budget, 0, 1)
    }

    this.state.live = this.fluid.count
    this.writeOutput('emitted', this.state.emitted)
    this.writeOutput('active', active)
  }

  /** Inspector action: toggle the manual tap. */
  toggleManual() {
    this.properties.manual = !this.properties.manual
    this.state.manual = this.properties.manual
    return this.properties.manual
  }

  readState() {
    return {
      Tap: this.state.active ? 'OPEN' : 'closed',
      'Emitted': `${this.state.emitted} particles`,
      'Live in world': `${this.state.live}`,
      'Exit speed': `${this.properties.speed} cm/s`,
    }
  }

  draw(ctx) {
    const { position: p, rotation } = this
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.roundRect?.(-32, -20, 64, 40, 6) ?? ctx.rect(-32, -20, 64, 40)
    ctx.fillStyle = '#0f2436'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()
    // nozzle pipe
    ctx.beginPath()
    ctx.rect(18, -7, (this.properties.nozzleLength ?? 40) - 14, 14)
    ctx.fillStyle = '#153f52'
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    if (this.state.active) {
      const nozzle = this.nozzle
      ctx.save()
      ctx.strokeStyle = 'rgba(56,189,248,0.55)'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(nozzle.x, nozzle.y)
      ctx.lineTo(nozzle.x + Math.cos(this.rotation) * 22, nozzle.y + Math.sin(this.rotation) * 22)
      ctx.stroke()
      ctx.restore()
    }

    if (this.selected || this.hovered) {
      drawTag(ctx, p.x, p.y - 32, this.state.active ? 'TAP OPEN' : 'tap closed', {
        color: this.state.active ? '#7dd3fc' : '#94a3b8',
      })
    }
  }
}

function hash(value) {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
