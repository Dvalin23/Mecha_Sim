import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { drawLed, drawTag } from '../draw/gizmo.js'

/**
 * Relay module — a finite state machine.
 *
 * States: `OPEN` ⇄ `CLOSED`, with the two physical timings a real
 * electromechanical relay has: the **operate time** (coil energised → contacts
 * close) and the **release time** (coil de-energised → contacts open). Modelling
 * them matters: they are the reason a relay cannot follow a 200 Hz control loop
 * and why the "chatter" failure mode is real.
 *
 * Modes
 *   normally-open    energised → CLOSED   (default)
 *   normally-closed  energised → OPEN
 *   latching         a rising edge flips the contact state and holds it, even
 *                    after the coil is released (bistable relay)
 */
export class Relay extends Component {
  static type = 'Relay'
  static label = 'Relay'
  static group = 'Logic'
  static accent = '#f472b6'
  static icon = '⊟'
  static description = 'Electromechanical relay FSM with operate/release delays and a latching mode.'
  static phase = ComponentPhase.LOGIC
  static ports = {
    inputs: [{ id: 'coil', label: 'Coil', kind: PortKind.DIGITAL }],
    outputs: [
      { id: 'switched', label: 'NO', kind: PortKind.DIGITAL },
      { id: 'normallyClosed', label: 'NC', kind: PortKind.DIGITAL },
      { id: 'cycles', label: 'Cycle count', kind: PortKind.ANALOG },
    ],
  }
  static controls = [
    {
      key: 'mode',
      label: 'Contact mode',
      type: 'select',
      default: 'normally-open',
      options: [
        { value: 'normally-open', label: 'Normally open (NO)' },
        { value: 'normally-closed', label: 'Normally closed (NC)' },
        { value: 'latching', label: 'Latching / bistable' },
      ],
    },
    { key: 'operateMs', label: 'Operate time', type: 'number', min: 0, max: 300, step: 1, default: 10, unit: 'ms' },
    { key: 'releaseMs', label: 'Release time', type: 'number', min: 0, max: 300, step: 1, default: 8, unit: 'ms' },
    { key: 'coilVoltage', label: 'Coil voltage', type: 'number', min: 1, max: 48, step: 1, default: 12, unit: 'V' },
  ]
  static probes = [
    { id: 'coil', label: 'Coil', unit: 'V', color: '#f472b6', read: (c) => (c.state.coil ? c.properties.coilVoltage : 0) },
    { id: 'contact', label: 'Contact', unit: '', color: '#4ade80', read: (c) => (c.state.closed ? 1 : 0) },
  ]

  initialize() {
    const housing = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 78,
      height: 52,
      angle: this.rotation,
      tag: 'logic',
      material: 'plastic',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.housing = housing
    this.bodies = [housing]
    this.state = {
      ...this.state,
      // A normally-closed contact is *closed* the moment it is energised by
      // nothing at all — starting it at `false` made the panel (and the canvas)
      // show OPEN until the first simulation step ran.
      closed: this.properties.mode === 'normally-closed',
      coil: false,
      pending: null,
      pendingUntil: 0,
      transitions: 0,
      cycles: 0,
      lastChangeAt: -Infinity,
      chatterDetected: false,
      armature: 0, // 0 = open, 1 = closed (animation value)
    }
  }

  update(dt) {
    const props = this.properties
    const coil = this.readInput('coil') === true
    const time = this.time
    const wasCoil = this.state.coil
    this.state.coil = coil

    const isNC = props.mode === 'normally-closed'
    const isLatching = props.mode === 'latching'

    if (isLatching) {
      // Bistable: a rising edge on the coil flips the contact and it stays put.
      const risingEdge = coil && !wasCoil
      if (risingEdge && this.state.pending === null) {
        const target = !this.state.closed
        this.state.pending = target
        this.state.pendingUntil = time + Math.max(props.operateMs, props.releaseMs) / 1000
      }
    } else {
      const wanted = isNC ? !coil : coil
      if (wanted !== this.state.closed && this.state.pending === null) {
        this.state.pending = wanted
        this.state.pendingUntil =
          time + (wanted ? props.operateMs : props.releaseMs) / 1000
      } else if (wanted !== this.state.closed && this.state.pending === wanted) {
        // target still valid — wait out the mechanical delay
      } else if (wanted === this.state.closed && this.state.pending !== null) {
        // coil changed back mid-flight: abort the travel
        this.state.pending = null
      }
    }

    // Mechanical delay elapses → contacts move.
    if (this.state.pending !== null && time >= this.state.pendingUntil) {
      const next = this.state.pending
      this.state.pending = null
      if (next !== this.state.closed) {
        this.state.closed = next
        this.state.transitions++
        if (next) this.state.cycles++
        // Chatter detection: more than 8 actuations inside 2 s is a wiring bug.
        if (time - this.state.lastChangeAt < 2) {
          this.state.transitions > 8 ? (this.state.chatterDetected = true) : null
        } else {
          this.state.chatterDetected = false
          this.state.transitions = 0
        }
        this.state.lastChangeAt = time
      }
    }

    // Animate the armature toward its commanded position at a fixed rate.
    const armatureTarget = this.state.closed ? 1 : 0
    const speed = this.state.pending !== null ? 6 : 14
    this.state.armature += Math.sign(armatureTarget - this.state.armature) * Math.min(Math.abs(armatureTarget - this.state.armature), speed * dt)

    this.state.state = this.state.closed ? 'CLOSED' : 'OPEN'
    this.writeOutput('switched', this.state.closed)
    this.writeOutput('normallyClosed', !this.state.closed)
    this.writeOutput('cycles', this.state.cycles)
  }

  /** Reset the FSM (used by the demos' "reset" button and deserialization). */
  reset() {
    this.state.closed = this.state.state === 'CLOSED'
    this.state.pending = null
  }

  readState() {
    return {
      Contacts: this.state.state,
      Coil: this.state.coil ? `ENERGISED (${this.properties.coilVoltage} V)` : 'de-energised',
      'Operating time': `${this.state.pending === null ? '—' : 'switching'} ${this.properties.operateMs} ms / ${this.properties.releaseMs} ms`,
      'Switching cycles': `${this.state.cycles}`,
      'Chatter warning': this.state.chatterDetected ? 'YES — add hysteresis' : 'no',
    }
  }

  draw(ctx) {
    const { position: p, rotation } = this
    const w = 78
    const h = 52
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.roundRect?.(-w / 2, -h / 2, w, h, 6) ?? ctx.rect(-w / 2, -h / 2, w, h)
    ctx.fillStyle = '#1a1430'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()

    // Coil + armature schematic
    const armX = -18
    ctx.beginPath()
    for (let i = 0; i < 4; i++) {
      ctx.arc(armX, -12 + i * 7, 3.4, 0, Math.PI * 2)
    }
    ctx.strokeStyle = this.state.coil ? '#fbcfe8' : '#6b7280'
    ctx.lineWidth = 1.4
    ctx.stroke()

    // Armature bar rotating between the NO and NC contacts
    const angle = -0.55 + this.state.armature * 1.1
    ctx.save()
    ctx.translate(armX, 10)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(38, 0)
    ctx.strokeStyle = this.state.closed ? '#4ade80' : '#94a3b8'
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(38, 0, 2.6, 0, Math.PI * 2)
    ctx.fillStyle = this.state.closed ? '#4ade80' : '#94a3b8'
    ctx.fill()
    ctx.restore()

    ctx.font = '600 8px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillStyle = 'rgba(244,114,182,0.85)'
    ctx.textAlign = 'right'
    ctx.fillText('NO', w / 2 - 6, -h / 2 + 12)
    ctx.fillText('NC', w / 2 - 6, h / 2 - 8)
    ctx.restore()

    drawLed(ctx, p.x + 22, p.y - 14, 4, this.state.closed, {
      onColor: '#4ade80',
      glow: 10,
    })
    drawLed(ctx, p.x + 22, p.y + 2, 4, this.state.coil, { onColor: '#f472b6', glow: 8 })

    if (this.selected || this.hovered || this.state.chatterDetected) {
      drawTag(
        ctx,
        p.x,
        p.y - 40,
        this.state.pending !== null ? 'switching…' : this.state.state,
        { color: this.state.closed ? '#86efac' : '#93c5fd' },
      )
    }
  }
}
