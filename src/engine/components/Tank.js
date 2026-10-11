import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { Vec2 } from '../math/Vec2.js'
import { drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * Reservoir with a level sensor.
 *
 * The tank is *measured*, not scripted: the fluid system sums the mass of every
 * droplet inside the interior volume, and the level is that mass divided by the
 * capacity computed from the interior geometry
 *
 *     capacity ≈ (w / 2r) · (h / 2r) · 0.78 · m_droplet      (0.78 = random packing)
 *
 * Which means the level readout responds to real conservation of water: drain it
 * through the valve and the number drops; the pump refills it and the number
 * climbs. That is the feedback loop the controller's hysteresis is fighting.
 */
export class Tank extends Component {
  static type = 'Tank'
  static label = 'Water Tank'
  static group = 'Fluid'
  static accent = '#2dd4bf'
  static icon = '▽'
  static description = 'Holds water and reports a measured level. Level, volume and a hysteretic "full" flag.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [],
    outputs: [
      { id: 'level', label: 'Level %', kind: PortKind.ANALOG },
      { id: 'volume', label: 'Volume', kind: PortKind.ANALOG },
      { id: 'full', label: 'Full', kind: PortKind.DIGITAL },
      { id: 'empty', label: 'Empty', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'width', label: 'Interior width', type: 'number', min: 60, max: 700, step: 10, default: 230, unit: 'cm' },
    { key: 'height', label: 'Interior height', type: 'number', min: 40, max: 600, step: 10, default: 150, unit: 'cm' },
    { key: 'wall', label: 'Wall thickness', type: 'number', min: 6, max: 40, step: 2, default: 12, unit: 'cm' },
    { key: 'fullAt', label: 'Full threshold', type: 'number', min: 20, max: 100, step: 1, default: 90, unit: '%' },
    { key: 'filterMs', label: 'Level filter', type: 'number', min: 0, max: 1500, step: 10, default: 120, unit: 'ms' },
    { key: 'capacityScale', label: 'Calibration', type: 'number', min: 0.05, max: 4, step: 0.05, default: 1 },
    { key: 'cistern', label: 'Cistern (no walls)', type: 'boolean', default: false },
    { key: 'geometry', label: 'Build walls', type: 'boolean', default: true },
    { key: 'drainGap', label: 'Floor drain gap', type: 'number', min: 0, max: 200, step: 4, default: 0, unit: 'cm' },
  ]
  static probes = [
    { id: 'level', label: 'Level', unit: '%', color: '#2dd4bf', read: (c) => c.state.level },
    { id: 'count', label: 'Droplets', unit: '', color: '#38bdf8', read: (c) => c.state.count },
  ]

  initialize() {
    this._buildGeometry()
    const wall = this.properties.wall
    const props = this.properties
    this._interior = {
      minX: this.position.x - props.width / 2 + wall,
      minY: this.position.y - props.height,
      maxX: this.position.x + props.width / 2 - wall,
      maxY: this.position.y - 4,
    }
    this.state = { ...this.state, level: 0, volume: 0, count: 0, capacity: this.computeCapacity(), full: false, empty: true }
  }

  _buildGeometry() {
    for (const body of this.bodies) this.world?.removeBody(body)
    this.bodies = []
    const props = this.properties

    // `geometry: false` turns the tank into a pure level *sensor*: the user
    // builds the vessel out of Wall parts and mounts this inside it.
    if (props.geometry === false) {
      this._interior = {
        minX: this.position.x - props.width / 2,
        minY: this.position.y - props.height,
        maxX: this.position.x + props.width / 2,
        maxY: this.position.y,
      }
      return
    }

    const wall = props.wall
    const halfW = props.width / 2
    const h = props.height
    const gap = clamp(props.drainGap ?? 0, 0, props.width - 20)
    const ud = { componentId: this.id, componentType: this.type }
    const parts = []
    if (!props.cistern) {
      parts.push(
        staticBox({ x: this.position.x - halfW - wall / 2, y: this.position.y - h / 2, width: wall, height: h + wall, tag: 'tank', userData: ud }),
        staticBox({ x: this.position.x + halfW + wall / 2, y: this.position.y - h / 2, width: wall, height: h + wall, tag: 'tank', userData: ud }),
      )
    }
    // Floor — with an optional drain opening for a valve to sit in.
    if (gap > 0) {
      const sideWidth = (props.width - gap) / 2
      parts.push(
        staticBox({ x: this.position.x - gap / 2 - sideWidth / 2, y: this.position.y, width: sideWidth, height: wall, tag: 'tank', userData: ud }),
        staticBox({ x: this.position.x + gap / 2 + sideWidth / 2, y: this.position.y, width: sideWidth, height: wall, tag: 'tank', userData: ud }),
      )
    } else {
      parts.push(
        staticBox({ x: this.position.x, y: this.position.y, width: props.width + wall * 2, height: wall, tag: 'tank', userData: ud }),
      )
    }
    this.bodies = parts
    for (const body of parts) this.world?.addBody(body)
    this._interior = {
      minX: this.position.x - halfW + wall,
      minY: this.position.y - h,
      maxX: this.position.x + halfW - wall,
      maxY: this.position.y - wall / 2,
    }
  }

  /** Droplets that fit when the tank is brim-full (hexagonal-ish packing). */
  computeCapacity() {
    const radius = this.fluid?.radius ?? 5
    const interiorW = Math.max(this.properties.width - this.properties.wall * 2, radius * 2)
    const interiorH = Math.max(this.properties.height - this.properties.wall, radius * 2)
    const perRow = Math.floor(interiorW / (radius * 2))
    const rows = Math.floor(interiorH / (radius * 2))
    // 0.78 ≈ random close packing for equal discs; `capacityScale` lets the
    // operator calibrate the sensor against a real fill test.
    return Math.max(perRow * rows * 0.78 * (this.properties.capacityScale ?? 1), 1)
  }

  attach(simulation) {
    super.attach(simulation)
    for (const body of this.bodies) if (!this.world.bodies.includes(body)) this.world.addBody(body)
    return this
  }

  handlePropertyChange(key) {
    if (['width', 'height', 'wall', 'cistern', 'geometry', 'drainGap'].includes(key)) {
      this._buildGeometry()
      this.state.capacity = this.computeCapacity()
    }
  }

  update(dt) {
    const props = this.properties
    const measured = this.fluid.measureVolume(
      this._interior.minX,
      this._interior.minY,
      this._interior.maxX,
      this._interior.maxY,
    )
    const capacity = this.state.capacity || this.computeCapacity()
    const percent = clamp((measured.count / capacity) * 100, 0, 100)
    const alpha = rcAlpha(dt, Math.max(props.filterMs, 1) / 1000)

    this.state.level = ema(this.state.level, percent, alpha)
    this.state.count = measured.count
    // "Volume" in litres: 1 droplet ≈ 1 cm³ at 5 cm radius scaled by the world
    // scale (100 px = 1 m), i.e. one droplet ≈ 0.52 L of virtual water.
    this.state.volume = measured.count * 0.52
    this.state.empty = this.state.level < 2
    this.state.full = this.state.level >= props.fullAt

    this.writeOutput('level', Math.round(this.state.level * 10) / 10)
    this.writeOutput('volume', Math.round(this.state.volume * 100) / 100)
    this.writeOutput('full', this.state.full)
    this.writeOutput('empty', this.state.empty)
  }

  readState() {
    return {
      Level: `${this.state.level.toFixed(1)} %`,
      Volume: `${this.state.volume.toFixed(1)} L`,
      Droplets: `${this.state.count} / ${Math.round(this.state.capacity)}`,
      Flags: `${this.state.full ? 'FULL ' : ''}${this.state.empty ? 'EMPTY' : ''}` || '—',
    }
  }

  draw(ctx) {
    const { minX, minY, maxX, maxY } = this._interior
    ctx.save()
    // Water body: height proportional to the measured level.
    const fillTop = maxY - (maxY - minY) * clamp(this.state.level / 100, 0, 1)
    const gradient = ctx.createLinearGradient(0, fillTop, 0, maxY)
    gradient.addColorStop(0, 'rgba(56,189,248,0.42)')
    gradient.addColorStop(1, 'rgba(37,99,235,0.28)')
    ctx.fillStyle = gradient
    ctx.fillRect(minX, fillTop, maxX - minX, maxY - fillTop)
    // Surface line with a gentle ripple so it reads as a liquid.
    ctx.strokeStyle = 'rgba(125,211,252,0.85)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const ripple = Math.sin(performance.now() / 260) * 1.6
    ctx.moveTo(minX, fillTop + ripple)
    ctx.quadraticCurveTo((minX + maxX) / 2, fillTop - ripple * 1.5, maxX, fillTop + ripple)
    ctx.stroke()
    // Level scale marks
    ctx.strokeStyle = 'rgba(45,212,191,0.35)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const y = minY + ((maxY - minY) * i) / 4
      ctx.beginPath()
      ctx.moveTo(minX, y)
      ctx.lineTo(minX + 14, y)
      ctx.stroke()
    }
    ctx.restore()

    if (this.selected || this.hovered || this.state.full) {
      drawTag(ctx, (minX + maxX) / 2, minY - 18, `${this.state.level.toFixed(1)}% · ${this.state.volume.toFixed(1)} L`, {
        color: this.state.full ? '#5eead4' : '#99f6e4',
      })
    }
  }
}

export { Vec2 }
