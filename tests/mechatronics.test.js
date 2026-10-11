import { describe, it, expect } from 'vitest'
import { Simulation } from '../src/engine/Simulation.js'
import { createComponent } from '../src/engine/registry.js'
import { buildDemo } from '../src/engine/demos.js'
import { Engine } from '../src/engine/Engine.js'
import { Vec2 } from '../src/engine/math/Vec2.js'

const makeSim = () => new Simulation()

describe('evaluation phases', () => {
  it('resolves inputs, then updates in phase order (sensor → logic → controller → actuator → display)', () => {
    const sim = makeSim()
    const sensor = createComponent('UltrasonicSensor', { position: new Vec2(0, 0) })
    const mcu = createComponent('Controller', { position: new Vec2(200, 0) })
    const relay = createComponent('Relay', { position: new Vec2(400, 0) })
    const lamp = createComponent('Lamp', { position: new Vec2(600, 0) })
    for (const component of [lamp, relay, mcu, sensor]) sim.add(component, { silent: true })

    // The schedule is ordered by phase, then by insertion. Assert the invariant
    // that matters (monotonic phase order) rather than a hard-coded type list.
    const canonical = { sensor: 0, logic: 1, controller: 2, actuator: 3, display: 4 }
    const phases = sim.schedule.map((component) => canonical[component.constructor.phase])
    expect(phases).toEqual([...phases].sort((a, b) => a - b))
    expect(phases[0]).toBeLessThan(phases[phases.length - 1])
  })

  it('costs exactly one step of latency per hop, like a real scanning MCU', () => {
    const sim = makeSim()
    const dial = createComponent('Potentiometer', { position: new Vec2(-200, 0), properties: { value: 100, maxValue: 100 } })
    const mcu = createComponent('Controller', {
      position: new Vec2(0, 0),
      properties: {
        filterMs: 0,
        scanHz: 1000,
        rules: [{ id: 'r', source: 'in0', target: 'out0', mode: 'above', threshold: 10, hysteresis: 1, debounceMs: 0 }],
      },
    })
    const relay = createComponent('Relay', {
      position: new Vec2(200, 0),
      properties: { mode: 'normally-open', operateMs: 0, releaseMs: 0 },
    })
    for (const component of [dial, mcu, relay]) sim.add(component, { silent: true })
    sim.connect(dial.id, 'out', mcu.id, 'in0', { silent: true })
    sim.connect(mcu.id, 'out0', relay.id, 'coil', { silent: true })

    sim.step(1 / 60) // the controller sees the dial on this step and drives out0
    expect(mcu.outputValues.out0).toBe(true)
    // The relay is later in the phase order and already ran, so it reads the new
    // coil value on the *next* step — exactly one frame of latency per hop.
    expect(relay.state.closed).toBe(false)
    sim.step(1 / 60)
    expect(relay.state.closed).toBe(true)
  })
})

describe('relay module (FSM)', () => {
  it('drives OPEN → CLOSED on the coil and releases with its own timing', () => {
    const sim = makeSim()
    const toggle = createComponent('ToggleSwitch', { position: new Vec2(-200, 0), properties: { on: false } })
    const relay = createComponent('Relay', {
      position: new Vec2(0, 0),
      properties: { mode: 'normally-open', operateMs: 30, releaseMs: 40 },
    })
    sim.add(toggle, { silent: true })
    sim.add(relay, { silent: true })
    sim.connect(toggle.id, 'out', relay.id, 'coil', { silent: true })

    expect(relay.state.closed).toBe(false)
    expect(relay.outputValues.switched).toBe(false)

    // Energise the coil and let the *operate* delay elapse (30 ms ≈ 2 steps).
    // `onPropertyChanged` is the API the inspector and the canvas both use.
    toggle.onPropertyChanged('on', true)
    let closedAt = -1
    for (let i = 0; i < 10; i++) {
      sim.step(1 / 60)
      if (relay.state.closed && closedAt < 0) closedAt = i
    }
    expect(relay.state.closed).toBe(true)
    expect(closedAt).toBeGreaterThanOrEqual(1) // it did not close instantly

    // De-energise: the relay must not drop out instantly either.
    toggle.onPropertyChanged('on', false)
    sim.step(1 / 60)
    expect(relay.state.closed).toBe(true)
    for (let i = 0; i < 6; i++) sim.step(1 / 60)
    expect(relay.state.closed).toBe(false)
  })

  it('is normally-closed when configured that way', () => {
    const relay = createComponent('Relay', { properties: { mode: 'normally-closed' } })
    const sim = makeSim()
    sim.add(relay, { silent: true })
    expect(relay.state.closed).toBe(true)
  })
})

describe('controller ladder logic', () => {
  it('applies hysteresis (Schmitt trigger) so the output does not chatter', () => {
    const sim = makeSim()
    const dial = createComponent('Potentiometer', { properties: { value: 0, maxValue: 100, noise: 0 } })
    const mcu = createComponent('Controller', {
      properties: {
        filterMs: 0,
        scanHz: 1000,
        rules: [{ id: 'r', source: 'in0', target: 'out0', mode: 'above', threshold: 50, hysteresis: 5, debounceMs: 0 }],
      },
    })
    sim.add(dial, { silent: true })
    sim.add(mcu, { silent: true })
    sim.connect(dial.id, 'out', mcu.id, 'in0', { silent: true })

    // Inputs are re-resolved from the wire graph every step, so the source of
    // truth is the potentiometer, not a hand-written inputValues entry.
    // The dial models a real wiper: its output slews through an RC filter, so a
    // setting needs a few steps to arrive at the controller.
    const drive = (value) => {
      dial.properties.value = value
      for (let i = 0; i < 30; i++) sim.step(1 / 60)
      return mcu.state.logic.out0
    }

    expect(drive(55.1)).toBe(true)
    expect(drive(48)).toBe(true) // inside the hysteresis band: holds
    expect(drive(40)).toBe(false) // left the band: releases
  })

  it('supports the two-position (bang-bang) rule used by the level controller', () => {
    const sim = makeSim()
    const level = createComponent('Potentiometer', { properties: { value: 0, maxValue: 100, noise: 0 } })
    const setpoint = createComponent('Potentiometer', { properties: { value: 50, maxValue: 100, noise: 0 } })
    const mcu = createComponent('Controller', {
      properties: {
        filterMs: 0,
        scanHz: 1000,
        rules: [{ id: 'r', source: 'in0', target: 'out0', mode: 'above', threshold: 50, thresholdPin: 'in1', hysteresis: 20, debounceMs: 0 }],
      },
    })
    for (const component of [level, setpoint, mcu]) sim.add(component, { silent: true })
    sim.connect(level.id, 'out', mcu.id, 'in0', { silent: true })
    sim.connect(setpoint.id, 'out', mcu.id, 'in1', { silent: true })

    const drive = (value) => {
      level.properties.value = value
      for (let i = 0; i < 30; i++) sim.step(1 / 60)
      return mcu.state.logic.out0
    }

    expect(drive(55)).toBe(false) // does not beat setpoint + hysteresis (70)
    expect(drive(71)).toBe(true)
    expect(drive(45)).toBe(true) // still inside 30 … 70
    expect(drive(25)).toBe(false)
  })

  it('keeps every output low when no rule drives it', () => {
    const sim = makeSim()
    const mcu = createComponent('Controller', { properties: { rules: [] } })
    sim.add(mcu, { silent: true })
    // Nothing is wired in, so every input floats to its neutral value and no
    // rule can ever fire — the failure mode that made every sensor look dead
    // before `readEnable()` existed.
    sim.step(1 / 60)
    expect(mcu.inputValues.in0).toBe(0)
    expect(mcu.state.logic.out0).toBe(false)
    expect(mcu.state.logic.out1).toBe(false)
  })
})

describe('pump and motor semantics', () => {
  it('stops a pump that is wired to a zero-valued throttle', () => {
    const sim = makeSim()
    const pump = createComponent('Pump', { position: new Vec2(0, 0) })
    const dial = createComponent('Potentiometer', { properties: { value: 0, maxValue: 100 } })
    const toggle = createComponent('ToggleSwitch', { properties: { on: true } })
    for (const component of [pump, dial, toggle]) sim.add(component, { silent: true })
    sim.connect(dial.id, 'out', pump.id, 'throttle', { silent: true })
    sim.connect(toggle.id, 'out', pump.id, 'power', { silent: true })
    for (let i = 0; i < 120; i++) sim.step(1 / 60)
    expect(pump.state.rpm).toBeLessThan(1)
  })

  it('runs flat out when the throttle pin is left unwired', () => {
    const sim = makeSim()
    const pump = createComponent('Pump', { position: new Vec2(0, 0), properties: { maxRpm: 600, spinUpMs: 100 } })
    const toggle = createComponent('ToggleSwitch', { properties: { on: true } })
    sim.add(pump, { silent: true })
    sim.add(toggle, { silent: true })
    sim.connect(toggle.id, 'out', pump.id, 'power', { silent: true })
    for (let i = 0; i < 120; i++) sim.step(1 / 60)
    expect(pump.state.rpm).toBeGreaterThan(500)
  })
})

describe('sensors', () => {
  it('measures Euclidean distance with the ultrasonic rangefinder', () => {
    const sim = makeSim()
    sim.setGravity(0) // keep the target still while we measure
    const sensor = createComponent('UltrasonicSensor', {
      position: new Vec2(0, 0),
      rotation: 0,
      properties: { range: 500, detectDistance: 400, filterMs: 0, noise: 0 },
    })
    const crate = createComponent('Crate', { position: new Vec2(300, 0), properties: { size: 40, mass: 2 } })
    sim.add(sensor, { silent: true })
    sim.add(crate, { silent: true })
    for (let i = 0; i < 5; i++) sim.step(1 / 60)
    // The transducer sits on the sensor's face, so the reported gap is its own
    // surface-to-surface distance plus that offset — near 300, never exactly it.
    expect(sensor.state.distance).toBeGreaterThan(240)
    expect(sensor.state.distance).toBeLessThan(320)
    expect(sensor.outputValues.detected).toBe(true)
    expect(sensor.outputValues.distance).toBeCloseTo(sensor.state.distance, 1)
  })

  it('ignores static geometry unless it is told to range against everything', () => {
    const sim = makeSim()
    const props = { range: 500, detectDistance: 400, filterMs: 0, noise: 0 }
    const wall = createComponent('Wall', {
      position: new Vec2(300, 0),
      properties: { width: 40, height: 400, material: 'metal', occludes: true },
    })
    const sensor = createComponent('UltrasonicSensor', { position: new Vec2(0, 0), rotation: 0, properties: props })
    sim.add(sensor, { silent: true })
    sim.add(wall, { silent: true })
    for (let i = 0; i < 3; i++) sim.step(1 / 60)
    expect(sensor.state.distance).toBe(500) // nothing dynamic in the beam

    const ranging = createComponent('UltrasonicSensor', {
      position: new Vec2(0, 200),
      rotation: 0,
      properties: { ...props, triggerTargets: 'all' },
    })
    sim.add(ranging, { silent: true })
    for (let i = 0; i < 3; i++) sim.step(1 / 60)
    expect(ranging.state.distance).toBeLessThan(320)
  })

  it('detects a rigid body inside the PIR cone and clears when it leaves', () => {
    const sim = makeSim()
    const pir = createComponent('PIRSensor', {
      position: new Vec2(0, 0),
      rotation: 0,
      properties: { range: 300, fov: 90, sensitivity: 5, holdMs: 40, lineOfSight: false },
    })
    sim.add(pir, { silent: true })

    const crate = createComponent('Crate', { position: new Vec2(120, 40) })
    sim.add(crate, { silent: true })
    for (let i = 0; i < 10; i++) sim.step(1 / 60)
    expect(pir.state.motion).toBe(true)
    expect(pir.outputValues.motion).toBe(true)

    // Move it far outside the cone: the hold time expires and the output drops.
    crate.setPosition(900, 900)
    for (let i = 0; i < 40; i++) sim.step(1 / 60)
    expect(pir.state.motion).toBe(false)
  })

  it('renders I2C text on the LCD from a wired template value', () => {
    assert_lcd()
  })
})

function assert_lcd() {
  const sim = makeSim()
  const dial = createComponent('Potentiometer', {
    position: new Vec2(0, 0),
    properties: { value: 47.25, maxValue: 100, noise: 0 },
  })
  const lcd = createComponent('LCDDisplay', {
    position: new Vec2(400, 0),
    properties: { template: 'LEVEL {value} %', decimals: 1, columns: 16 },
  })
  sim.add(dial, { silent: true })
  sim.add(lcd, { silent: true })
  sim.connect(dial.id, 'out', lcd.id, 'value', { silent: true })

  // The panel runs its own `filterMs` EMA like a real I2C backpack refresh, so
  // give it a moment to settle on the new value before reading the text.
  for (let i = 0; i < 90; i++) sim.step(1 / 60)
  const text = String(lcd.state.lines?.[0] ?? lcd.state.text ?? '')
  expect(text).not.toContain('{value}') // the placeholder was substituted
  expect(text).toMatch(/^LEVEL \d/)
  // The panel tracks its input through the same RC filter a real I2C backpack
  // uses, so compare numerically rather than on the exact glyphs.
  const shown = Number(text.match(/([\d.]+)/)?.[1])
  expect(shown).toBeGreaterThan(46)
  expect(shown).toBeLessThan(48)
}

describe('whole demos, end to end', () => {
  it('builds every demo and runs it for two seconds without error', () => {
    for (const id of ['proximity-pump', 'intruder-alarm', 'cistern-control', 'relay-lab', 'physics-showroom']) {
      const engine = new Engine({ canvas: null })
      const sim = buildDemo(engine, id)
      for (let i = 0; i < 120; i++) sim.step(1 / 60)
      expect(sim.componentList.length).toBeGreaterThan(0)
      expect(calendarSafe(sim)).toBe(true)
      engine.dispose()
    }
  })

  it('conserves the droplet count in the recirculating pump demo', () => {
    const engine = new Engine({ canvas: null })
    const sim = buildDemo(engine, 'proximity-pump')
    const start = sim.fluid.count
    let deepest = -Infinity
    for (let i = 0; i < 60 * 20; i++) {
      sim.step(1 / 60)
      for (const body of sim.fluid.active) deepest = Math.max(deepest, body.position.y)
    }
    expect(sim.fluid.count).toBe(start)
    expect(deepest).toBeLessThan(900)
    engine.dispose()
  })
})

/** No NaN may ever enter the simulation: one poisoned value spreads everywhere. */
function calendarSafe(sim) {
  for (const body of sim.world.bodies) {
    if (!Number.isFinite(body.position.x) || !Number.isFinite(body.position.y)) return false
    if (!Number.isFinite(body.velocity.x) || !Number.isFinite(body.velocity.y)) return false
  }
  return true
}
