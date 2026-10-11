import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { raycast } from '../physics/queries.js'
import { Vec2 } from '../math/Vec2.js'
import { drawLed, drawTag, formatValue } from '../draw/gizmo.js'
import { mulberry32, rcAlpha, ema } from '../math/utils.js'

/**
 * HC-SR04-style ultrasonic rangefinder, implemented with raycasting.
 *
 * A ray is projected from the transducer along the component's facing direction
 * and marched through the spatial hash grid. The first intersection gives the
 * echo distance:
 *
 *     d = √((x₂ − x₁)² + (y₂ − y₁)²)      [world px, 1 px = 1 cm]
 *
 * The reading is then pushed through a first-order IIR filter and mixed with
 * deterministic Gaussian noise so the raw signal in the oscilloscope looks like
 * the real thing (and so controller hysteresis has something to chew on).
 * Sound travel time is modelled too: `speedOfSound` (344 m/s = 34 400 cm/s)
 * governs how fast `distance` is allowed to slew, which is why a real HC-SR04
 * cannot report every wall it passes instantly.
 */
export class UltrasonicSensor extends Component {
  static type = 'UltrasonicSensor'
  static label = 'Ultrasonic'
  static group = 'Sensors'
  static accent = '#38bdf8'
  static icon = '≪'
  static description = 'Raycast rangefinder. Emits an analog distance in cm plus a digital proximity flag.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [{ id: 'enable', label: 'Enable', kind: PortKind.DIGITAL }],
    outputs: [
      { id: 'distance', label: 'Distance (cm)', kind: PortKind.ANALOG },
      { id: 'detected', label: 'Detected', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'range', label: 'Range', type: 'number', min: 50, max: 1600, step: 10, default: 500, unit: 'cm' },
    { key: 'detectDistance', label: 'Trigger under', type: 'number', min: 5, max: 800, step: 5, default: 80, unit: 'cm' },
    { key: 'beamAngle', label: 'Beam spread', type: 'number', min: 2, max: 60, step: 1, default: 15, unit: '°' },
    { key: 'noise', label: 'Sensor noise', type: 'number', min: 0, max: 5, step: 0.1, default: 0.4, unit: 'cm' },
    { key: 'filterMs', label: 'Slew limit', type: 'number', min: 0, max: 400, step: 10, default: 45, unit: 'ms' },
    { key: 'triggerTargets', label: 'Targets', type: 'select', default: 'dynamic', options: [
      { value: 'dynamic', label: 'Dynamic parts only' },
      { value: 'all', label: 'Everything (incl. walls)' },
    ] },
  ]
  static probes = [
    { id: 'distance', label: 'Distance', unit: 'cm', color: '#38bdf8', read: (c) => c.state.distance },
    { id: 'raw', label: 'Raw echo', unit: 'cm', color: '#818cf8', read: (c) => c.state.rawDistance },
  ]

  initialize() {
    const angle = this.rotation
    const housing = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 54,
      height: 26,
      angle,
      tag: 'sensor',
      material: 'plastic',
      userData: { componentId: this.id, componentType: this.type },
    })
    housing.gravityScale = 0
    this.housing = housing
    this.bodies = [housing]
    this._rand = mulberry32(hashString(this.id))
    this.state = {
      ...this.state,
      distance: this.properties.range,
      rawDistance: this.properties.range,
      detected: false,
      targetTag: null,
      beamHits: 0,
      filtered: this.properties.range,
    }
  }

  /** Transducer origin — the two eyes sit a little ahead of the plate. */
  get transducer() {
    const offset = 16
    return new Vec2(
      this.position.x + Math.cos(this.rotation) * offset,
      this.position.y + Math.sin(this.rotation) * offset,
    )
  }

  update(dt) {
    const props = this.properties
    const enabled = this.readEnable('enable')
    if (!enabled) {
      this.writeOutput('distance', props.range)
      this.writeOutput('detected', false)
      this.state.distance = props.range
      this.state.targetTag = null
      return
    }

    const origin = this.transducer
    const ignore = new Set([this.housing.uid])
    const hit = raycast(this.world, origin, this.rotation, props.range, {
      ignore,
      mask: 0b1111,
    })

    let raw
    if (hit && (props.triggerTargets === 'all' || hit.body.isDynamic)) {
      raw = hit.distance
      this.state.targetTag = hit.body.userData?.componentType ?? hit.body.tag
      this.state.hitPoint = hit.point
      this.state.normal = hit.normal
      this.state.beamHits = hit.body.uid
    } else {
      raw = props.range
      this.state.targetTag = null
      this.state.hitPoint = null
      this.state.beamHits = 0
    }

    // Deterministic sensor noise (same seed → same readings → replayable).
    if (props.noise > 0) {
      raw += (this._rand() - 0.5) * 2 * props.noise
    }
    this.state.rawDistance = raw

    // Hardware echo integration: distance cannot change faster than sound can
    // travel out and back (2·d / c per second), which naturally models the
    // "ghosting" of a real module sweeping past geometry.
    const maxSlew = (34400 / 2) * dt
    const delta = raw - this.state.distance
    const slewed = Math.abs(delta) <= maxSlew ? raw : this.state.distance + Math.sign(delta) * maxSlew
    const alpha = rcAlpha(dt, Math.max(props.filterMs, 1) / 1000)
    this.state.distance = ema(this.state.distance, slewed, alpha)

    const detected = this.state.distance <= props.detectDistance
    this.state.detected = detected
    this.writeOutput('distance', Math.round(this.state.distance * 100) / 100)
    this.writeOutput('detected', detected)
  }

  handlePropertyChange(key, value) {
    if (key === 'range' || key === 'detectDistance' || key === 'noise' || key === 'filterMs') return
    if (key === 'beamAngle') return
  }

  readState() {
    return {
      'Distance': `${this.state.distance.toFixed(1)} cm`,
      'Target': this.state.targetTag ?? '— none —',
      'Flag': this.state.detected ? 'HIGH' : 'LOW',
      'Range': `${this.properties.range} cm`,
    }
  }

  draw(ctx) {
    const { position: p, rotation } = this
    // Housing plate
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)
    ctx.fillStyle = '#132038'
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect?.(-27, -13, 54, 26, 4)
    if (!ctx.roundRect) ctx.rect(-27, -13, 54, 26)
    ctx.fill()
    ctx.stroke()
    // The two transducers
    for (const dy of [-7, 7]) {
      ctx.beginPath()
      ctx.arc(9, dy, 6.5, 0, Math.PI * 2)
      ctx.fillStyle = '#0b1220'
      ctx.fill()
      ctx.strokeStyle = this.state.detected ? '#4ade80' : '#2b3d5f'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.restore()

    // Beam
    const origin = this.transducer
    const end = this.state.hitPoint ?? {
      x: origin.x + Math.cos(rotation) * this.properties.range,
      y: origin.y + Math.sin(rotation) * this.properties.range,
    }
    ctx.save()
    ctx.strokeStyle = this.state.targetTag ? 'rgba(74,222,128,0.9)' : 'rgba(56,189,248,0.42)'
    ctx.lineWidth = this.state.targetTag ? 1.8 : 1.2
    ctx.setLineDash(this.state.targetTag ? [] : [7, 6])
    ctx.beginPath()
    ctx.moveTo(origin.x, origin.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
    ctx.restore()

    if (this.state.hitPoint) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(this.state.hitPoint.x, this.state.hitPoint.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#4ade80'
      ctx.fill()
      ctx.restore()
    }

    if (this.selected || this.hovered) {
      drawTag(
        ctx,
        this.position.x,
        this.position.y - 30,
        `${this.state.distance.toFixed(1)} cm`,
        { color: '#cfe9ff' },
      )
    }
  }
}

/** Cheap deterministic string hash for per-instance PRNG seeds. */
export function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export { formatValue, drawLed }
