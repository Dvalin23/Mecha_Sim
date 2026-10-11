import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox, dynamicBox } from './bodyFactory.js'
import { boxShape } from '../physics/shapes.js'
import { drawTag, hatchRect } from '../draw/gizmo.js'
import { clamp } from '../math/utils.js'

/**
 * Structural parts: the static geometry a scene is built out of, plus a dynamic
 * crate that gives the motion sensor something to see.
 */

/** Immovable wall / platform / ramp. */
export class Wall extends Component {
  static type = 'Wall'
  static label = 'Wall / Platform'
  static group = 'Structure'
  static accent = '#94a3b8'
  static icon = '▬'
  static description = 'Static terrain. Blocks sensors line-of-sight, holds fluid and gives the motor something to fling crates against.'
  static phase = ComponentPhase.LOGIC
  static ports = { inputs: [], outputs: [] }
  static controls = [
    { key: 'width', label: 'Length', type: 'number', min: 20, max: 2000, step: 10, default: 320, unit: 'cm' },
    { key: 'height', label: 'Thickness', type: 'number', min: 6, max: 300, step: 2, default: 18, unit: 'cm' },
    { key: 'tilt', label: 'Tilt', type: 'number', min: -90, max: 90, step: 1, default: 0, unit: '°' },
    { key: 'material', label: 'Material', type: 'select', default: 'metal', options: [
      { value: 'metal', label: 'Steel (low bounce)' },
      { value: 'rubber', label: 'Rubber (bouncy)' },
      { value: 'ice', label: 'Ice (frictionless)' },
      { value: 'wood', label: 'Wood' },
    ] },
    { key: 'occludes', label: 'Blocks sensors', type: 'boolean', default: true },
  ]

  initialize() {
    const body = this._makeBody()
    this.bodies = [body]
    this.body = body
  }

  _makeBody() {
    const props = this.properties
    const body = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: props.width,
      height: props.height,
      angle: this.rotation + (props.tilt * Math.PI) / 180,
      tag: props.occludes ? 'terrain' : 'decoration',
      material: props.material,
      userData: { componentId: this.id, componentType: this.type },
    })
    // Non-occluding walls are decorative: they still collide, but the sensors'
    // raycasts ignore TERRAIN-tagged decoration via the layer mask below.
    if (!props.occludes) body.layer = 0b1000
    return body
  }

  _rebuild() {
    const old = this.body
    const body = this._makeBody()
    this.world?.removeBody(old)
    this.body = body
    this.bodies = [body]
    this.world?.addBody(body)
  }

  handlePropertyChange() {
    this._rebuild()
  }

  update() {}

  readState() {
    return {
      Size: `${this.properties.width} × ${this.properties.height} cm`,
      Tilt: `${this.properties.tilt}°`,
      Material: this.properties.material,
      'Blocks sensors': this.properties.occludes ? 'yes' : 'no',
    }
  }

  draw(ctx) {
    const props = this.properties
    const angle = this.rotation + (props.tilt * Math.PI) / 180
    ctx.save()
    ctx.translate(this.position.x, this.position.y)
    ctx.rotate(angle)
    const w = props.width
    const h = props.height
    ctx.beginPath()
    ctx.rect(-w / 2, -h / 2, w, h)
    ctx.fillStyle = props.material === 'rubber' ? '#2b2b33' : props.material === 'ice' ? '#1f3548' : '#26303f'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.4
    ctx.stroke()
    if (props.occludes) hatchRect(ctx, -w / 2, -h / 2, w, h, 14, 'rgba(148,163,184,0.18)')
    ctx.restore()
    if (this.selected || this.hovered) {
      drawTag(ctx, this.position.x, this.position.y - props.height / 2 - 16, 'static', {
        color: '#cbd5e1',
      })
    }
  }
}

/** Dynamic crate — the movable "thing" that sensors watch and motors fling. */
export class Crate extends Component {
  static type = 'Crate'
  static label = 'Crate'
  static group = 'Structure'
  static accent = '#fb923c'
  static icon = '▣'
  static description = 'Dynamic box. Ideal target for the PIR cone and the ultrasonic beam.'
  static phase = ComponentPhase.LOGIC
  static ports = {
    inputs: [{ id: 'teleport', label: 'Recoil', kind: PortKind.DIGITAL }],
    outputs: [
      { id: 'speed', label: 'Speed', kind: PortKind.ANALOG },
      { id: 'angle', label: 'Tilt', kind: PortKind.ANALOG },
    ],
  }
  static controls = [
    { key: 'size', label: 'Size', type: 'number', min: 16, max: 200, step: 2, default: 46, unit: 'cm' },
    { key: 'mass', label: 'Mass', type: 'number', min: 0.1, max: 200, step: 0.1, default: 3, unit: 'kg' },
    { key: 'restitution', label: 'Bounciness', type: 'number', min: 0, max: 1, step: 0.05, default: 0.18 },
    { key: 'friction', label: 'Friction', type: 'number', min: 0, max: 1.5, step: 0.05, default: 0.5 },
    { key: 'spawnX', label: 'Home X', type: 'number', min: -2000, max: 4000, step: 5, default: 0, unit: 'cm' },
    { key: 'spawnY', label: 'Home Y', type: 'number', min: -2000, max: 4000, step: 5, default: 0, unit: 'cm' },
  ]
  static probes = [{ id: 'speed', label: 'Crate speed', unit: 'cm/s', color: '#fb923c', read: (c) => c.state.speed }]

  initialize() {
    const props = this.properties
    const body = dynamicBox({
      x: this.position.x,
      y: this.position.y,
      width: props.size,
      height: props.size,
      angle: this.rotation,
      mass: props.mass,
      restitution: props.restitution,
      friction: props.friction,
      tag: 'dynamic',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.bodies = [body]
    this.body = body
    this.state = { ...this.state, speed: 0, tilt: 0, teleports: 0 }
  }

  handlePropertyChange(key, value) {
    if (key === 'size' || key === 'mass') {
      this.body.setShape(boxShape(value, value))
      this.body.setMass(this.properties.mass)
      this.body.wake()
    }
    if (key === 'restitution') this.body.restitution = value
    if (key === 'friction') this.body.friction = value
  }

  update() {
    this.state.speed = Math.round(this.body.speed)
    this.state.tilt = Math.round((this.body.angle * 180) / Math.PI)
    this.writeOutput('speed', this.state.speed)
    this.writeOutput('angle', this.state.tilt)

    if (this.readInput('teleport') === true) {
      const props = this.properties
      const homeX = props.spawnX || this.position.x
      const homeY = props.spawnY || this.position.y
      if (this.body.position.distanceTo({ x: homeX, y: homeY }) > 4) {
        this.body.setPosition(homeX, homeY)
        this.body.velocity.set(0, 0)
        this.body.angularVelocity = 0
        this.state.teleports++
      }
    }
  }

  readState() {
    return {
      Speed: `${this.state.speed} cm/s`,
      Tilt: `${this.state.tilt}°`,
      Mass: `${this.properties.mass} kg`,
      Recalls: `${this.state.teleports}`,
    }
  }

  draw(ctx) {
    const props = this.properties
    const half = props.size / 2
    ctx.save()
    ctx.translate(this.body.position.x, this.body.position.y)
    ctx.rotate(this.body.angle)
    ctx.beginPath()
    ctx.roundRect?.(-half, -half, props.size, props.size, 4) ?? ctx.rect(-half, -half, props.size, props.size)
    const gradient = ctx.createLinearGradient(-half, -half, half, half)
    gradient.addColorStop(0, '#7c3f12')
    gradient.addColorStop(1, '#a85a1c')
    ctx.fillStyle = gradient
    ctx.fill()
    ctx.strokeStyle = '#fdba74'
    ctx.lineWidth = 1.6
    ctx.stroke()
    // Plank detail
    ctx.beginPath()
    ctx.moveTo(-half, -half * 0.25)
    ctx.lineTo(half, -half * 0.25)
    ctx.moveTo(-half, half * 0.35)
    ctx.lineTo(half, half * 0.35)
    ctx.strokeStyle = 'rgba(253,186,116,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    if (this.selected || this.hovered) {
      drawTag(ctx, this.body.position.x, this.body.position.y - half - 16, `${this.state.speed} cm/s`, {
        color: '#fed7aa',
      })
    }
  }
}

export { clamp }
