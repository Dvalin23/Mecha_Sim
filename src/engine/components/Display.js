import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { drawLed, drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * I2C character LCD (16×2 style).
 *
 * The display intercepts whatever the microcontroller writes and renders it
 * straight onto the canvas with `ctx.fillText` — it is a *view* of the data
 * pipeline, which is why it renders in the engine's overlay pass and not in
 * React. The template string supports `{value}`, `{text}`, `{unit}` and `\n`
 * for the second row.
 */
export class LCDDisplay extends Component {
  static type = 'LCDDisplay'
  static label = 'I2C LCD 16×2'
  static group = 'Output'
  static accent = '#67e8f9'
  static icon = '▭'
  static description = 'Character display. Formats an analog input through a template and draws it on the canvas.'
  static phase = ComponentPhase.DISPLAY
  static ports = {
    inputs: [
      { id: 'value', label: 'Data', kind: PortKind.ANALOG },
      { id: 'text', label: 'Text', kind: PortKind.TEXT },
      { id: 'power', label: 'Backlight', kind: PortKind.DIGITAL },
    ],
    outputs: [],
  }
  static controls = [
    { key: 'template', label: 'Line 1 template', type: 'text', default: 'DIST {value} {unit}' },
    { key: 'template2', label: 'Line 2 template', type: 'text', default: 'STATUS {text}' },
    { key: 'decimals', label: 'Decimals', type: 'number', min: 0, max: 3, step: 1, default: 1 },
    { key: 'unit', label: 'Unit suffix', type: 'text', default: 'cm' },
    { key: 'filterMs', label: 'Update filter', type: 'number', min: 0, max: 1500, step: 10, default: 180, unit: 'ms' },
    { key: 'backlight', label: 'Backlight on', type: 'boolean', default: true },
    { key: 'columns', label: 'Columns', type: 'number', min: 8, max: 24, step: 1, default: 16 },
  ]
  static probes = [
    { id: 'value', label: 'Data in', unit: '', color: '#67e8f9', read: (c) => c.state.raw },
  ]

  initialize() {
    const board = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 132,
      height: 62,
      angle: this.rotation,
      tag: 'display',
      material: 'plastic',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.bodies = [board]
    this.board = board
    this.state = { ...this.state, raw: 0, displayed: 0, lines: ['', ''], text: '', lit: this.properties.backlight }
  }

  /** Render the template with the current data (the "I2C transaction"). */
  format(template, context) {
    const props = this.properties
    const value = Number.isFinite(context.value) ? context.value.toFixed(props.decimals) : '—'
    return String(template ?? '')
      .replace(/\{value\}/g, value)
      .replace(/\{raw\}/g, String(Math.round(context.value)))
      .replace(/\{text\}/g, context.text || '')
      .replace(/\{unit\}/g, props.unit ?? '')
      .replace(/\{seq\}/g, String(this.simulation.sampleCount))
      .slice(0, props.columns * 2)
  }

  update(dt) {
    const props = this.properties
    const value = Number(this.readInput('value')) || 0
    const text = String(this.readInput('text') ?? '')
    const powerInput = this.readInput('power')
    const lit = props.backlight && (powerInput === true || this.simulation.incoming(this.id, 'power').length === 0)

    const alpha = rcAlpha(dt, Math.max(props.filterMs, 1) / 1000)
    this.state.raw = value
    this.state.displayed = ema(this.state.displayed, value, alpha)
    this.state.text = text
    this.state.lit = lit

    const context = { value: this.state.displayed, text }
    this.state.lines = [
      this.format(props.template, context),
      this.format(props.template2, context),
    ]
  }

  readState() {
    return {
      'Line 1': this.state.lines[0] || '(blank)',
      'Line 2': this.state.lines[1] || '(blank)',
      Backlight: this.state.lit ? 'on' : 'off',
      'Data': `${this.state.raw.toFixed(2)}`,
    }
  }

  /** Drawn in the overlay pass so the text is never occluded by geometry. */
  drawOverlay(ctx) {
    const props = this.properties
    const { position: p, rotation } = this
    const w = 132
    const h = 62
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)

    // PCB
    ctx.beginPath()
    ctx.roundRect?.(-w / 2, -h / 2, w, h, 5) ?? ctx.rect(-w / 2, -h / 2, w, h)
    ctx.fillStyle = '#0a2a2e'
    ctx.fill()
    ctx.strokeStyle = '#134e4a'
    ctx.lineWidth = 4
    ctx.stroke()

    // Glass
    const glassW = w - 22
    const glassH = h - 20
    ctx.beginPath()
    ctx.rect(-glassW / 2, -glassH / 2, glassW, glassH)
    ctx.fillStyle = this.state.lit ? '#0f766e' : '#0b1f24'
    ctx.fill()
    ctx.strokeStyle = 'rgba(103,232,249,0.4)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Glyph grid (unlit cells)
    ctx.globalAlpha = this.state.lit ? 0.12 : 0.05
    for (let col = 0; col < props.columns; col++) {
      for (let row = 0; row < 2; row++) {
        ctx.fillStyle = '#a5f3fc'
        ctx.fillRect(-glassW / 2 + 6 + col * ((glassW - 12) / props.columns), -glassH / 2 + 5 + row * (glassH / 2), 5, 7)
      }
    }
    ctx.globalAlpha = 1

    // Characters
    ctx.fillStyle = this.state.lit ? '#d9fbff' : 'rgba(217,251,255,0.45)'
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const rowHeight = glassH / 2
    const chars = Math.max(props.columns, 1)
    this.state.lines.forEach((line, row) => {
      const padded = line.slice(0, chars).padEnd(0)
      ctx.fillText(padded, -glassW / 2 + 7, -glassH / 2 + rowHeight * 0.5 + row * rowHeight)
    })

    // Scanline shimmer: unmistakably "a device", not a text label.
    if (this.state.lit) {
      ctx.globalAlpha = 0.06
      ctx.fillStyle = '#ffffff'
      const y = (performance.now() / 14) % glassH
      ctx.fillRect(-glassW / 2, -glassH / 2 + y, glassW, 1.5)
      ctx.globalAlpha = 1
    }
    ctx.restore()

    if (this.selected || this.hovered) {
      drawTag(ctx, p.x, p.y - 44, 'LCD', { color: '#a5f3fc' })
    }
  }
}

/**
 * Indicator lamp — the audible/visual half of an alarm circuit. Supports a
 * blink rate so a relay-driven beacon pulses instead of sitting static.
 */
export class Lamp extends Component {
  static type = 'Lamp'
  static label = 'Indicator Lamp'
  static group = 'Output'
  static accent = '#fde047'
  static icon = '☀'
  static description = 'Glowing indicator with optional blink and analog brightness.'
  static phase = ComponentPhase.DISPLAY
  static ports = {
    inputs: [
      { id: 'power', label: 'Power', kind: PortKind.DIGITAL },
      { id: 'brightness', label: 'Brightness', kind: PortKind.ANALOG },
    ],
    outputs: [],
  }
  static controls = [
    { key: 'color', label: 'Colour', type: 'select', default: 'amber', options: [
      { value: 'amber', label: 'Amber' },
      { value: 'red', label: 'Red' },
      { value: 'green', label: 'Green' },
      { value: 'blue', label: 'Blue' },
    ] },
    { key: 'blinkHz', label: 'Blink rate', type: 'number', min: 0, max: 12, step: 0.5, default: 0, unit: 'Hz' },
    { key: 'size', label: 'Diameter', type: 'number', min: 10, max: 120, step: 2, default: 34, unit: 'cm' },
  ]
  static probes = [
    { id: 'on', label: 'Lamp', unit: '', color: '#fde047', read: (c) => (c.state.on ? 1 : 0) },
  ]
  static COLORS = { amber: '#fde047', red: '#f87171', green: '#4ade80', blue: '#60a5fa' }

  initialize() {
    this.bodies = [
      staticBox({
        x: this.position.x,
        y: this.position.y,
        width: 40,
        height: 30,
        angle: this.rotation,
        tag: 'output',
        material: 'plastic',
        userData: { componentId: this.id, componentType: this.type },
      }),
    ]
    this.state = { ...this.state, on: false, phase: 0, brightness: 0 }
  }

  update(dt) {
    const props = this.properties
    const powered = this.readInput('power') === true
    const analog = Number(this.readInput('brightness'))
    const level = clamp(Number.isFinite(analog) && this.simulation.incoming(this.id, 'brightness').length ? analog / 100 : 1, 0, 1)

    this.state.phase = (this.state.phase + dt * (props.blinkHz || 0)) % 1
    const blinkOn = (props.blinkHz || 0) === 0 || this.state.phase < 0.5
    this.state.on = powered && blinkOn
    this.state.brightness = powered ? level * (blinkOn ? 1 : 0.15) : 0.08
  }

  readState() {
    return {
      Lamp: this.state.on ? 'ON' : 'off',
      Brightness: `${(this.state.brightness * 100).toFixed(0)} %`,
      Colour: this.properties.color,
      'Blink': `${this.properties.blinkHz} Hz`,
    }
  }

  drawOverlay(ctx) {
    const color = Lamp.COLORS[this.properties.color] ?? Lamp.COLORS.amber
    const radius = this.properties.size / 2
    const { x, y } = this.position
    const intensity = this.state.brightness

    ctx.save()
    if (intensity > 0.05) {
      const glow = radius * (1.4 + intensity * 1.6)
      const gradient = ctx.createRadialGradient(x, y, radius * 0.3, x, y, glow)
      gradient.addColorStop(0, `${color}${Math.round(intensity * 200).toString(16).padStart(2, '0')}`)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(x, y, glow, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = intensity > 0.2 ? color : '#1e293b'
    ctx.fill()
    ctx.strokeStyle = 'rgba(15,23,42,0.8)'
    ctx.lineWidth = 2
    ctx.stroke()
    // Filament cross
    ctx.beginPath()
    ctx.moveTo(x - radius * 0.5, y)
    ctx.lineTo(x + radius * 0.5, y)
    ctx.moveTo(x, y - radius * 0.5)
    ctx.lineTo(x, y + radius * 0.5)
    ctx.strokeStyle = intensity > 0.2 ? 'rgba(255,255,255,0.65)' : 'rgba(148,163,184,0.35)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()

    if (this.selected || this.hovered) {
      drawTag(ctx, x, y - radius - 18, this.state.on ? 'ON' : 'OFF', { color })
    }
  }
}

export { drawLed, ema }
