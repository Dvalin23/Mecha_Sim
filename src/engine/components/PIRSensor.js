import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { queryCone } from '../physics/queries.js'
import { Vec2 } from '../math/Vec2.js'
import { drawCone, drawTag } from '../draw/gizmo.js'
import { clamp } from '../math/utils.js'

/**
 * PIR motion detector.
 *
 * Models the pyroelectric element as a **triangular field of view**: the sensor
 * projects a wedge of `fov` degrees out to `range`, and every rigid body whose
 * centre falls inside that triangle is tracked frame to frame. Motion is the
 * magnitude of the displacement vector:
 *
 *     Δp = |p_t − p_{t−1}| / Δt        [px/s]
 *
 * A body moving faster than `sensitivity` latches the sensor HIGH for `holdMs`
 * (exactly like a real HC-SR501's retriggerable monostable). Line-of-sight is
 * raycast, so ducking behind a wall genuinely hides you from the sensor.
 */
export class PIRSensor extends Component {
  static type = 'PIRSensor'
  static label = 'PIR Motion'
  static group = 'Sensors'
  static accent = '#facc15'
  static icon = '◠'
  static description = 'Triangular field-of-view motion detector with hold time and line-of-sight occlusion.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [{ id: 'enable', label: 'Enable', kind: PortKind.DIGITAL }],
    outputs: [
      { id: 'motion', label: 'Motion', kind: PortKind.DIGITAL },
      { id: 'speed', label: 'Target speed', kind: PortKind.ANALOG },
      { id: 'count', label: 'Bodies in view', kind: PortKind.ANALOG },
    ],
  }
  static controls = [
    { key: 'range', label: 'Detection range', type: 'number', min: 60, max: 900, step: 10, default: 300, unit: 'cm' },
    { key: 'fov', label: 'Field of view', type: 'number', min: 15, max: 170, step: 5, default: 70, unit: '°' },
    { key: 'sensitivity', label: 'Min speed', type: 'number', min: 1, max: 400, step: 1, default: 25, unit: 'cm/s' },
    { key: 'holdMs', label: 'Hold time', type: 'number', min: 0, max: 5000, step: 50, default: 1200, unit: 'ms' },
    { key: 'lineOfSight', label: 'Occlusion', type: 'boolean', default: true },
  ]
  static probes = [
    { id: 'speed', label: 'Motion speed', unit: 'cm/s', color: '#facc15', read: (c) => c.state.speed },
    {
      id: 'motion',
      label: 'Motion flag',
      unit: '',
      color: '#fb923c',
      read: (c) => (c.state.motion ? 1 : 0),
    },
  ]

  initialize() {
    const housing = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 34,
      height: 34,
      angle: this.rotation,
      tag: 'sensor',
      material: 'plastic',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.housing = housing
    this.bodies = [housing]
    /** @type {Map<number, {x:number,y:number}>} previous positions of tracked bodies */
    this._previous = new Map()
    this.state = {
      ...this.state,
      motion: false,
      speed: 0,
      count: 0,
      targetId: null,
      lastTriggerAt: -Infinity,
      triggers: 0,
      heldUntil: 0,
    }
  }

  get origin() {
    return new Vec2(
      this.position.x + Math.cos(this.rotation) * 10,
      this.position.y + Math.sin(this.rotation) * 10,
    )
  }

  update(dt, ctx) {
    const props = this.properties
    const enabled = this.readEnable('enable')
    const halfAngle = (props.fov * Math.PI) / 360
    const origin = this.origin
    const bodies = enabled
      ? queryCone(this.simulation.world, origin, this.rotation, halfAngle, props.range, {
          includeFluid: false,
          lineOfSight: props.lineOfSight,
          tag: undefined,
          ignoreBodies: [this.housing],
        }).filter((entry) => entry.body !== this.housing)
      : []

    let fastest = 0
    let fastestId = null
    const seen = new Set()

    for (const entry of bodies) {
      const body = entry.body
      seen.add(body.uid)
      const previous = this._previous.get(body.uid)
      if (previous) {
        const dx = body.position.x - previous.x
        const dy = body.position.y - previous.y
        const speed = Math.hypot(dx, dy) / dt
        if (speed > fastest) {
          fastest = speed
          fastestId = body.userData?.componentId ?? body.id
        }
      } else if (bodies.length) {
        fastestId = body.userData?.componentId ?? body.id
      }
      this._previous.set(body.uid, { x: body.position.x, y: body.position.y })
    }
    // Forget bodies that left the cone so re-entry counts as fresh motion.
    for (const uid of [...this._previous.keys()]) {
      if (!seen.has(uid)) this._previous.delete(uid)
    }

    const now = ctx?.simulation?.world?.time ?? 0
    // Strictly faster than the threshold: the docstring says "moving faster than
    // `sensitivity`", and `>=` made a sensitivity of 0 latch HIGH forever — every
    // stationary body in the cone counted as motion.
    const triggered = fastest > props.sensitivity
    if (triggered) {
      if (now - this.state.lastTriggerAt > 0.15) this.state.triggers++
      this.state.lastTriggerAt = now
      this.state.heldUntil = now + props.holdMs / 1000
    }
    const latched = triggered || now < this.state.heldUntil

    this.state.motion = latched
    this.state.speed = Math.round(fastest)
    this.state.count = bodies.length
    this.state.targetId = fastestId
    this.state.fov = props.fov

    this.writeOutput('motion', latched)
    this.writeOutput('speed', Math.round(fastest))
    this.writeOutput('count', bodies.length)
  }

  readState() {
    return {
      Motion: this.state.motion ? 'DETECTED' : 'clear',
      'Target speed': `${this.state.speed} cm/s`,
      'In view': `${this.state.count}`,
      Triggers: `${this.state.triggers}`,
    }
  }

  draw(ctx) {
    const props = this.properties
    const origin = this.origin
    const halfAngle = (props.fov * Math.PI) / 360
    const hot = this.state.motion
    drawCone(ctx, origin, this.rotation, halfAngle, props.range, {
      fill: hot ? 'rgba(251,146,60,0.18)' : 'rgba(250,204,21,0.08)',
      stroke: hot ? 'rgba(251,146,60,0.75)' : 'rgba(250,204,21,0.4)',
    })

    ctx.save()
    ctx.translate(this.position.x, this.position.y)
    ctx.rotate(this.rotation)
    ctx.fillStyle = '#132038'
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(0, 0, 17, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Fresnel lens dome
    ctx.beginPath()
    ctx.arc(5, 0, 11, -1.2, 1.2)
    ctx.fillStyle = hot ? 'rgba(251,146,60,0.85)' : 'rgba(250,204,21,0.5)'
    ctx.fill()
    ctx.restore()

    if (hot) {
      ctx.save()
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120)
      ctx.strokeStyle = `rgba(251,146,60,${0.35 + pulse * 0.5})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(this.position.x, this.position.y, 24 + pulse * 6, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }

    if (this.selected || this.hovered) {
      drawTag(ctx, this.position.x, this.position.y - 34, `${this.state.speed} cm/s`, {
        color: hot ? '#fdba74' : '#fde68a',
      })
    }
  }
}

export { clamp }
