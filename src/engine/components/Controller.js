import { Component, ComponentPhase, PortKind } from '../Component.js'
import { staticBox } from './bodyFactory.js'
import { drawLed, drawTag } from '../draw/gizmo.js'
import { clamp, ema, rcAlpha } from '../math/utils.js'

/**
 * Virtual microcontroller — the logic gate of the mechatronics layer.
 *
 * Every step it:
 *   1. **polls** its analog input pins (fed by the sensors across the netlist),
 *   2. low-pass filters each pin with a first-order IIR (anti-alias / debounce),
 *   3. evaluates the user's **rule table** with *hysteresis* and *debounce*,
 *   4. **fires** the resulting boolean onto its digital output pins.
 *
 * Hysteresis (a Schmitt trigger, in software) is what stops a relay from
 * chatter-boxing when a rangefinder parks exactly on its threshold:
 *
 *     engage  when  v > T + h
 *     release when  v < T − h
 *
 * Rule modes
 *   `above`  v > T            → HIGH
 *   `below`  v < T            → HIGH
 *   `window` min ≤ v ≤ max    → HIGH
 *   `toggle` rising edge across T flips the output (a virtual flip-flop)
 *   `always` constant HIGH (manual override / bench testing)
 */
export class Controller extends Component {
  static type = 'Controller'
  static label = 'Microcontroller'
  static group = 'Logic'
  static accent = '#a78bfa'
  static icon = '▤'
  static description = 'Polls analog inputs, applies threshold rules with hysteresis, drives digital outputs.'
  static phase = ComponentPhase.CONTROLLER
  static ports = {
    inputs: [
      { id: 'in0', label: 'A0', kind: PortKind.ANALOG },
      { id: 'in1', label: 'A1', kind: PortKind.ANALOG },
      { id: 'in2', label: 'A2', kind: PortKind.ANALOG },
      { id: 'in3', label: 'A3', kind: PortKind.ANALOG },
    ],
    outputs: [
      { id: 'out0', label: 'D0', kind: PortKind.DIGITAL },
      { id: 'out1', label: 'D1', kind: PortKind.DIGITAL },
      { id: 'out2', label: 'D2', kind: PortKind.DIGITAL },
      { id: 'out3', label: 'D3', kind: PortKind.DIGITAL },
    ],
  }
  static controls = [
    { key: 'scanHz', label: 'Scan rate', type: 'number', min: 10, max: 240, step: 10, default: 60, unit: 'Hz' },
    { key: 'filterMs', label: 'Input filter', type: 'number', min: 0, max: 800, step: 10, default: 60, unit: 'ms' },
    { key: 'invertOutputs', label: 'Active-low outputs', type: 'boolean', default: false },
  ]
  static probes = [
    { id: 'in0', label: 'A0', unit: '', color: '#38bdf8', read: (c) => c.state.filtered.in0 },
    { id: 'in1', label: 'A1', unit: '', color: '#facc15', read: (c) => c.state.filtered.in1 },
    { id: 'out0', label: 'D0', unit: '', color: '#4ade80', read: (c) => (c.state.logic.out0 ? 1 : 0) },
    { id: 'out1', label: 'D1', unit: '', color: '#f472b6', read: (c) => (c.state.logic.out1 ? 1 : 0) },
  ]
  static defaults = {
    rules: [
      {
        id: 'rule-1',
        source: 'in0',
        target: 'out0',
        mode: 'below',
        threshold: 50,
        hysteresis: 5,
        min: 0,
        max: 100,
        debounceMs: 40,
        invert: false,
        label: 'Trigger on proximity',
      },
    ],
  }

  initialize() {
    const board = staticBox({
      x: this.position.x,
      y: this.position.y,
      width: 96,
      height: 66,
      angle: this.rotation,
      tag: 'logic',
      material: 'plastic',
      userData: { componentId: this.id, componentType: this.type },
    })
    this.board = board
    this.bodies = [board]
    const rules = this.properties.rules ?? []
    this.state = {
      ...this.state,
      filtered: { in0: 0, in1: 0, in2: 0, in3: 0 },
      logic: { out0: false, out1: false, out2: false, out3: false },
      ruleStates: Object.fromEntries(rules.map((r) => [r.id, false])),
      ruleRaw: Object.fromEntries(rules.map((r) => [r.id, false])),
      ruleSettle: Object.fromEntries(rules.map((r) => [r.id, 0])),
      toggleArmed: Object.fromEntries(rules.map((r) => [r.id, false])),
      scanAccumulator: 0,
      scans: 0,
      inputHistory: [],
    }
  }

  get rules() {
    return this.properties.rules ?? []
  }

  setRules(rules) {
    this.properties.rules = rules
    for (const rule of rules) {
      if (!(rule.id in this.state.ruleStates)) {
        this.state.ruleStates[rule.id] = false
        this.state.ruleRaw[rule.id] = false
        this.state.ruleSettle[rule.id] = 0
        this.state.toggleArmed[rule.id] = false
      }
    }
    this.state.ruleStates = { ...this.state.ruleStates }
    return this
  }

  /** Analog reading of a pin (raw, before filtering). */
  readPin(portId) {
    const value = this.readInput(portId)
    return typeof value === 'number' ? value : value ? 1 : 0
  }

  update(dt) {
    const props = this.properties
    const scanInterval = 1 / clamp(props.scanHz || 60, 1, 1000)

    // 1) Poll every pin continuously and low-pass filter it (anti-alias +
    //    mechanical debounce of the sensor itself).
    for (const port of this.ports.inputs) {
      const raw = this.readPin(port.id)
      const alpha = rcAlpha(dt, Math.max(props.filterMs, 1) / 1000)
      this.state.filtered[port.id] = ema(this.state.filtered[port.id], raw, alpha)
    }

    // 2) …but only run the rule engine at the configured scan rate, exactly like
    //    firmware bound to a hardware timer interrupt.
    this.state.scanAccumulator += dt
    if (this.state.scanAccumulator < scanInterval) return
    this.state.scanAccumulator = Math.min(this.state.scanAccumulator - scanInterval, scanInterval)
    this.state.scans++

    // 3) Evaluate every rule into its raw (pre-combine) value, with debouncing.
    const groups = new Map() // pin → { or: [], and: [] }
    for (const rule of this.rules) {
      const pin = rule.target ?? 'out0'
      if (!groups.has(pin)) groups.set(pin, { or: [], and: [] })
      const group = groups.get(pin)
      const raw = this.evaluateRule(rule, dt)
      const bucket = rule.combine === 'and' ? group.and : group.or
      bucket.push(raw)
    }

    // 4) Combine per pin — this is ladder logic:
    //      'or'  rules are parallel contacts (any one energises the coil)
    //      'and' rules are series contacts (all must hold; they inhibit)
    //    A pin with only one kind of rule simply gets that kind.
    const outputs = { out0: false, out1: false, out2: false, out3: false }
    for (const [pin, group] of groups) {
      const orValue = group.or.some(Boolean)
      const andValue = group.and.every(Boolean)
      outputs[pin] = group.or.length && group.and.length ? orValue && andValue : group.or.length ? orValue : andValue
      if (!group.and.length && group.or.length) outputs[pin] = orValue
    }
    if (this.rules.length === 0) {
      // No program loaded: outputs stay low (a blank MCU drives nothing).
      for (const pin of Object.keys(outputs)) outputs[pin] = false
    }

    if (props.invertOutputs) {
      for (const pin of Object.keys(outputs)) outputs[pin] = !outputs[pin]
    }

    this.state.logic = outputs
    for (const pin of Object.keys(outputs)) this.writeOutput(pin, outputs[pin])
  }

  /**
   * One rule → one boolean.
   *
   * Modes: above / below / window / toggle (edge-triggered flip-flop) / always.
   * Every comparison is a **Schmitt trigger**: the threshold to engage is
   * offset by `hysteresis` from the threshold to release, which is precisely
   * what stops a relay from chattering when a sensor parks on its setpoint.
   */
  evaluateRule(rule, dt) {
    const pin = rule.source ?? 'in0'
    const value = this.state.filtered[pin] ?? 0
    const previous = this.state.ruleStates[rule.id] ?? false
    const h = rule.hysteresis ?? 0
    // The setpoint can be a constant or another analog pin (operator dial).
    const threshold = rule.thresholdPin
      ? this.state.filtered[rule.thresholdPin] ?? 0
      : rule.threshold ?? 0
    let next = previous

    switch (rule.mode) {
      case 'above':
        next = previous ? value > threshold - h : value > threshold + h
        break
      case 'below':
        next = previous ? value < threshold + h : value < threshold - h
        break
      case 'window': {
        const min = rule.min ?? 0
        const max = rule.max ?? 100
        next = previous ? value > min - h && value < max + h : value > min + h && value < max - h
        break
      }
      case 'toggle': {
        // Rising edge across the threshold flips a virtual flip-flop.
        const armed = this.state.toggleArmed[rule.id] ?? false
        if (value > threshold + h && !armed) {
          next = !previous
          this.state.toggleArmed[rule.id] = true
        } else if (value < threshold - h) {
          this.state.toggleArmed[rule.id] = false
        }
        break
      }
      case 'always':
      default:
        next = true
        break
    }

    if (rule.invert) next = !next

    // Software debounce: the raw value must hold for `debounceMs` before the
    // rule state follows it (contact bounce, sensor glitches).
    const lastRaw = this.state.ruleRaw[rule.id] ?? false
    if (next !== lastRaw) {
      this.state.ruleRaw[rule.id] = next
      this.state.ruleSettle[rule.id] = 0
    } else {
      this.state.ruleSettle[rule.id] = (this.state.ruleSettle[rule.id] ?? 0) + dt
    }
    const debounceSeconds = (rule.debounceMs ?? 0) / 1000
    const settled = debounceSeconds <= 0 || (this.state.ruleSettle[rule.id] ?? 0) >= debounceSeconds
    if (settled) this.state.ruleStates[rule.id] = next
    return this.state.ruleStates[rule.id] ?? false
  }

  readState() {
    const rows = {}
    for (const port of this.ports.inputs) {
      const wired = this.simulation.incoming(this.id, port.id).length > 0
      rows[`${port.label}`] = wired ? `${this.state.filtered[port.id].toFixed(2)}` : '— floating —'
    }
    for (const port of this.ports.outputs) {
      rows[port.label] = this.state.logic[port.id] ? 'HIGH' : 'LOW'
    }
    rows.Scans = `${this.state.scans}`
    return rows
  }

  draw(ctx) {
    const { position: p, rotation } = this
    const w = 96
    const h = 66
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rotation)
    ctx.beginPath()
    ctx.roundRect?.(-w / 2, -h / 2, w, h, 7) ?? ctx.rect(-w / 2, -h / 2, w, h)
    ctx.fillStyle = '#141c33'
    ctx.fill()
    ctx.strokeStyle = this.accent
    ctx.lineWidth = 1.6
    ctx.stroke()

    // Pin 1 marker + silkscreen
    ctx.beginPath()
    ctx.arc(-w / 2 + 9, -h / 2 + 9, 3, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(167,139,250,0.85)'
    ctx.fill()

    ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillStyle = 'rgba(167,139,250,0.9)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('MCU-1', -w / 2 + 18, -h / 2 + 9)
    ctx.restore()

    // Output LEDs (drawn in world space so they stay axis-aligned).
    this.ports.outputs.forEach((port, index) => {
      const y = p.y - 18 + index * 12
      const on = this.state.logic[port.id]
      drawLed(ctx, p.x + 30, y, 4, on, { onColor: '#4ade80', glow: 9 })
      ctx.save()
      ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillStyle = on ? '#86efac' : '#475569'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(port.label, p.x + 38, y)
      ctx.restore()
    })

    if (this.selected || this.hovered) {
      const active = this.rules.filter((r) => this.state.ruleStates[r.id]).length
      drawTag(ctx, p.x, p.y - 46, `rules ${active}/${this.rules.length}`, { color: '#ddd6fe' })
    }
  }
}
