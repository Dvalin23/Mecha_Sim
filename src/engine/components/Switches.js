import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { drawLed, drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * Panel controls — the "human in the loop" inputs.
 *
 * These are the parts that let a scaffolding scene run without any hardware:
 * click the switch on the canvas and the logic downstream reacts.
 */

/** SPDT toggle switch: click to flip, digital output. */
export class ToggleSwitch extends Component {
  static type = 'ToggleSwitch'
  static label = 'Toggle Switch'
  static group = 'Input'
  static accent = '#c4b5fd'
  static icon = '⎋'
  static description = 'Click on the canvas or use the inspector to flip a digital output.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [],
    outputs: [
      { id: 'out', label: 'Out', kind: PortKind.DIGITAL },
      { id: 'inverted', label: 'Inverted', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'on', label: 'Closed (ON)', type: 'boolean', default: false },
    { key: 'momentary', label: 'Momentary (push-on)', type: 'boolean', default: false },
    { key: 'debounceMs', label: 'Debounce', type: 'number', min: 0, max: 200, step: 5, default: 20, unit: 'ms' },
  ]
  static probes = [{ id: 'out', label: 'Switch', unit: '', color: '#c4b5fd', read: (c) => (c.state.on ? 1 : 0) }]

  initialize() {
    this.bodies = [
      staticBox({
        x: this.position.x,
        y: this.position.y,
        width: 44,
        height: 36,
        angle: this.rotation,
        tag: 'input',
        material: 'plastic',
        userData: { componentId: this.id, componentType: this.type },
      }),
    ]
    this.state = { ...this.state, on: this.properties.on === true, held: false, clicks: 0, lastChangeAt: -Infinity }
  }

  get isOn() {
    return this.state.on
  }

  setOn(value) {
    const next = !!value
    if (next !== this.state.on) {
      this.state.on = next
      this.state.clicks++
      this.state.lastChangeAt = this.time
      this.properties.on = next
    }
    return this.state.on
  }

  toggle() {
    return this.setOn(!this.state.on)
  }

  /**
   * The inspector writes through `Component.onPropertyChanged`, which by default
   * only mutates `properties`. For a switch the *state* is the source of truth
   * (the canvas click path goes through `setOn`), so without this override the
   * "Closed (ON)" control in the inspector silently did nothing.
   */
  handlePropertyChange(key, value) {
    if (key === 'on') this.setOn(value)
  }

  onPointerDown(x, y) {
    if (this.properties.momentary) {
      this.state.held = true
      this.state.on = true
      this.state.clicks++
    } else {
      this.toggle()
    }
    this.state.lastChangeAt = this.time
    return true
  }

  onPointerUp() {
    if (!this.properties.momentary) return false
    this.state.held = false
    // Debounced release: a real switch bounces for a few ms.
    setTimeout(() => {
      if (!this.state.held) this.state.on = false
    }, this.properties.debounceMs)
    return true
  }

  update() {
    const on = this.state.on
    this.writeOutput('out', on)
    this.writeOutput('inverted', !on)
  }

  readState() {
    return {
      Contacts: this.state.on ? 'CLOSED' : 'OPEN',
      Type: this.properties.momentary ? 'momentary' : 'latching',
      Clicks: `${this.state.clicks}`,
    }
  }

  draw(ctx) {
    const { x, y } = this.position
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(this.rotation)
    ctx.beginPath()
    ctx.roundRect?.(-22, -18, 44, 36, 5) ?? ctx.rect(-22, -18, 44, 36)
    ctx.fillStyle = '#1b1836'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Lever
    ctx.save()
    ctx.translate(0, 4)
    ctx.rotate(this.state.on ? -0.5 : 0.5)
    ctx.beginPath()
    ctx.roundRect?.(-4, -14, 8, 20, 3) ?? ctx.rect(-4, -14, 8, 20)
    ctx.fillStyle = this.state.on ? '#c4b5fd' : '#4b5563'
    ctx.fill()
    ctx.restore()
    ctx.restore()
    if (this.selected || this.hovered) {
      drawTag(ctx, x, y - 30, this.state.on ? 'ON' : 'OFF', { color: '#ddd6fe' })
    }
  }
}

/** Push button: HIGH only while the pointer is held down. */
export class PushButton extends Component {
  static type = 'PushButton'
  static label = 'Push Button'
  static group = 'Input'
  static accent = '#fda4af'
  static icon = '⬤'
  static description = 'Momentary contact. Hold it down on the canvas to drive an output HIGH.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [],
    outputs: [
      { id: 'out', label: 'Pressed', kind: PortKind.DIGITAL },
      { id: 'released', label: 'Released', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'pulseMs', label: 'Auto-pulse', type: 'number', min: 0, max: 5000, step: 50, default: 0, unit: 'ms' },
    { key: 'keyboard', label: 'Bind to key', type: 'text', default: '' },
  ]
  static probes = [{ id: 'out', label: 'Button', unit: '', color: '#fda4af', read: (c) => (c.state.pressed ? 1 : 0) }]

  initialize() {
    this.bodies = [
      staticBox({
        x: this.position.x,
        y: this.position.y,
        width: 40,
        height: 40,
        angle: this.rotation,
        tag: 'input',
        material: 'plastic',
        userData: { componentId: this.id, componentType: this.type },
      }),
    ]
    this.state = { ...this.state, pressed: false, pressCount: 0, pulseUntil: 0 }
  }

  onPointerDown() {
    this.state.pressed = true
    this.state.pressCount++
    if (this.properties.pulseMs > 0) this.state.pulseUntil = this.time + this.properties.pulseMs / 1000
    return true
  }

  onPointerUp() {
    if (this.properties.pulseMs > 0) return true
    this.state.pressed = false
    return true
  }

  /** Fired by the engine when a bound keyboard key is held. */
  setPressed(value) {
    if (value === this.state.pressed) return
    this.state.pressed = value
    if (value) this.state.pressCount++
  }

  update() {
    if (this.state.pulseUntil > this.time) this.state.pressed = this.state.pressed || this.state.pulseUntil > this.time
    if (this.state.pulseUntil && this.time > this.state.pulseUntil) {
      this.state.pressed = false
      this.state.pulseUntil = 0
    }
    this.writeOutput('out', this.state.pressed)
    this.writeOutput('released', !this.state.pressed)
  }

  readState() {
    return { Contact: this.state.pressed ? 'CLOSED' : 'OPEN', Presses: `${this.state.pressCount}` }
  }

  draw(ctx) {
    const { x, y } = this.position
    const pressed = this.state.pressed
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, 20, 0, Math.PI * 2)
    ctx.fillStyle = pressed ? '#3f1d2b' : '#241b2b'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y + (pressed ? 2 : 0), pressed ? 12 : 14, 0, Math.PI * 2)
    ctx.fillStyle = pressed ? '#fda4af' : '#6b4053'
    ctx.fill()
    ctx.restore()
    if (this.selected || this.hovered || pressed) {
      drawTag(ctx, x, y - 32, pressed ? 'PRESSED' : 'ready', { color: '#fecdd3' })
    }
  }
}

/** Potentiometer: a 0–100 analog source, draggable on the canvas. */
export class Potentiometer extends Component {
  static type = 'Potentiometer'
  static label = 'Potentiometer'
  static group = 'Input'
  static accent = '#93c5fd'
  static icon = '◴'
  static description = 'Analog dial (0–100). Drag it on the canvas or type a value in the inspector.'
  static phase = ComponentPhase.SENSOR
  static ports = {
    inputs: [],
    outputs: [
      { id: 'out', label: 'Wiper', kind: PortKind.ANALOG },
      { id: 'percent', label: 'Percent', kind: PortKind.ANALOG },
    ],
  }
  static controls = [
    { key: 'value', label: 'Wiper position', type: 'number', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'maxValue', label: 'Full-scale value', type: 'number', min: 1, max: 5000, step: 1, default: 100 },
    { key: 'noise', label: 'Wiper noise', type: 'number', min: 0, max: 5, step: 0.1, default: 0.2 },
    { key: 'sweepHz', label: 'Auto sweep', type: 'number', min: 0, max: 2, step: 0.05, default: 0, unit: 'Hz' },
  ]
  static probes = [
    { id: 'out', label: 'Wiper', unit: '', color: '#93c5fd', read: (c) => c.state.value },
  ]

  initialize() {
    this.bodies = [
      staticBox({
        x: this.position.x,
        y: this.position.y,
        width: 52,
        height: 52,
        angle: this.rotation,
        tag: 'input',
        material: 'plastic',
        userData: { componentId: this.id, componentType: this.type },
      }),
    ]
    this.state = { ...this.state, value: this.properties.value, angle: -2.4, sweeps: 0 }
  }

  onPointerDrag(x, y) {
    // Project the pointer onto the dial face and map the angle to 0–100 %.
    const dx = x - this.position.x
    const dy = y - this.position.y
    if (Math.hypot(dx, dy) < 4) return false
    let angle = Math.atan2(dy, dx) + Math.PI / 2
    angle = clamp(angle, -2.4, 2.4)
    this.properties.value = clamp(50 + (angle / 2.4) * 50, 0, 100)
    return true
  }

  update(dt) {
    const props = this.properties
    if (props.sweepHz > 0) {
      // Triangle wave sweep: the classic "sensor simulator" for bench testing.
      const period = 1 / props.sweepHz
      const t = (this.time % period) / period
      props.value = t < 0.5 ? t * 200 : (1 - t) * 200
      this.state.sweeps = Math.floor(this.time / period)
    }
    const target = clamp(props.value, 0, 100)
    this.state.value = ema(this.state.value, target, rcAlpha(dt, 0.02))
    this.state.angle = -2.4 + (this.state.value / 100) * 4.8
    const noise = props.noise > 0 ? (Math.random() - 0.5) * 2 * props.noise : 0
    this.writeOutput('out', ((this.state.value / 100) * props.maxValue) + noise)
    this.writeOutput('percent', this.state.value + noise)
  }

  readState() {
    return {
      Wiper: `${this.state.value.toFixed(1)} %`,
      Output: `${((this.state.value / 100) * this.properties.maxValue).toFixed(1)}`,
      Sweep: this.properties.sweepHz > 0 ? `${this.properties.sweepHz} Hz` : 'off',
    }
  }

  draw(ctx) {
    const { x, y } = this.position
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, 25, 0, Math.PI * 2)
    ctx.fillStyle = '#16203a'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()
    // Dial ticks
    ctx.strokeStyle = 'rgba(147,197,253,0.5)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 10; i++) {
      const a = -2.4 + (i / 10) * 4.8 - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(x + Math.cos(a) * 17, y + Math.sin(a) * 17)
      ctx.lineTo(x + Math.cos(a) * 21, y + Math.sin(a) * 21)
      ctx.stroke()
    }
    // Knob
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(this.state.angle)
    ctx.beginPath()
    ctx.moveTo(0, -4)
    ctx.lineTo(0, -18)
    ctx.strokeStyle = '#bfdbfe'
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()
    drawLed(ctx, x, y, 5, this.state.value > 2, { onColor: '#60a5fa', glow: 8 })
    ctx.restore()

    if (this.selected || this.hovered) {
      drawTag(ctx, x, y - 34, `${this.state.value.toFixed(0)}%`, { color: '#bfdbfe' })
    }
  }
}
