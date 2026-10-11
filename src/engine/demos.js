import { Vec2 } from './math/Vec2.js'
import { emptyProject } from './serialization.js'

/**
 * Demo circuits.
 *
 * Each factory builds a complete scene programmatically — the exact same public
 * API the React UI drives (addComponent / connect / fluid.spawn) — so anything
 * you can build by hand here, you can build by dragging parts around. They
 * double as executable documentation and as the fixture set for the tests.
 */

/** Fluent scene builder used by the demos. */
export class SceneBuilder {
  constructor(engine) {
    this.engine = engine
    this.simulation = engine.simulation
    this.refs = {}
  }

  add(key, type, x, y, properties = {}, rotation = 0) {
    const component = this.engine.addComponent(type, { x, y }, { ...properties, rotation })
    if (rotation) component.setRotation(rotation)
    if (key) this.refs[key] = component
    return component
  }

  wall(x, y, width, height, properties = {}, rotation = 0) {
    return this.add(null, 'Wall', x, y, { width, height, ...properties }, rotation)
  }

  tank(x, y, width, height, key = null) {
    return this.add(key, 'Tank', x, y, { width, height, wall: 12 }, 0)
  }

  /** Two walls + a floor. Used for reservoirs and spillways. */
  basin(x, y, width, height, { wall = 16, floor = true, keyPrefix = 'basin' } = {}) {
    const left = this.wall(x - width / 2 - wall / 2, y - height / 2 + wall / 2, wall, height + wall)
    const right = this.wall(x + width / 2 + wall / 2, y - height / 2 + wall / 2, wall, height + wall)
    this.refs[`${keyPrefix}Left`] = left
    this.refs[`${keyPrefix}Right`] = right
    let bottom = null
    if (floor) {
      bottom = this.wall(x, y + wall / 2, width + wall * 2, wall)
      this.refs[`${keyPrefix}Floor`] = bottom
    }
    return { left, right, bottom }
  }

  water(x, y, count, spreadX = 90, spreadY = 60) {
    const fluid = this.simulation.fluid
    for (let i = 0; i < count; i++) {
      const px = x + ((i % 14) - 7) * (spreadX / 14) + (Math.random() - 0.5) * 3
      const py = y - Math.floor(i / 14) * (spreadY / 8) + (Math.random() - 0.5) * 3
      fluid.spawn(px, py, 0, 0)
    }
    return this
  }

  wire(fromKey, fromPort, toKey, toPort) {
    const from = this.refs[fromKey]
    const to = this.refs[toKey]
    if (!from || !to) throw new Error(`wire(): unknown component key ${fromKey}/${toKey}`)
    this.simulation.connect(from.id, fromPort, to.id, toPort)
    return this
  }

  get(key) {
    return this.refs[key]
  }
}

/** Fresh simulation + builder, ready to be populated. */
export function beginScene(engine, name) {
  const payload = emptyProject(name)
  engine.load(payload)
  engine.simulation.name = name
  return new SceneBuilder(engine)
}

/**
 * Demo 1 — "Proximity Pump" (the whitepaper's canonical circuit).
 *
 *   Ultrasonic ──distance──▶ MCU.A0 ──rule: d < setpoint──▶ D0 ──▶ Relay coil
 *   Relay NO ──▶ Pump power            Pump draft ──▶ water up into the Tank
 *   Tank.level ──▶ MCU.A1 ──rule: level > 92 % (AND, inverted)──▶ D0
 *   Potentiometer ──▶ MCU.A3 (live setpoint) and ──▶ LCD data
 *
 * Physics: a reservoir of droplets, a raised tank, a pump whose force field
 * lifts water along an arc. The MCU stops the pump when the tank fills — with
 * hysteresis, so the classic relay chatter is avoided.
 */
export function buildProximityPump(engine) {
  const scene = beginScene(engine, 'Proximity Pump')

  // --- site plan ---------------------------------------------------------
  // A pumping station that recirculates nothing but its own water:
  //
  //    ┌── tray (ice, −8°: the pile walks back to the sluice) ──┐
  //    │        ▲ arc lands here                               │
  //  ──┴──[ sluice gate ]─── basin ─────────────────────────────┴──── ground
  //        (drains into the basin)   ▲ pump drafts from here
  //
  // The layout is dictated by the pump's *measured* ballistic envelope: a
  // droplet leaves the impeller at ≈700 px/s (solver's per-step travel guard),
  // peaks ~190 px above the nozzle and lands ~400 px downrange, so the tray's
  // floor sits inside that arc and the basin is wide enough that no droplet can
  // strand outside the draft's reach.
  scene.wall(760, 900, 1680, 40)      // ground (safety net: nothing ever leaves)
  scene.wall(-16, 760, 60, 240)       // basin left wall  → x −46…14
  scene.wall(640, 760, 60, 240)       // basin right wall → x 610…670
  // Steep (≈49°) chutes instead of square corners. Square corners let water
  // stack *outside* the draft's radius and stay there: measured, 60 droplets sat
  // in a 130 px column against the right wall and the transfer stalled. At 49°
  // nothing can rest — every droplet walks back into the impeller.
  scene.wall(92, 790, 238, 26, { tilt: 49, material: 'ice' })
  scene.wall(530, 790, 241, 26, { tilt: -48, material: 'ice' })
  scene.wall(722, 680, 555, 26, { tilt: -8, material: 'ice' })  // tray floor: x 447…997
  scene.wall(1005, 628, 20, 150)      // tray backstop

  // Sensor shelf: the target crate parks in the rangefinder beam until it is
  // dragged away (or shoved by the relay reset).
  scene.wall(305, 470, 330, 16, { material: 'metal' })
  scene.add('crate', 'Crate', 305, 430, { size: 56, mass: 5, restitution: 0.15, friction: 0.7 })

  // Working fluid.
  scene.water(280, 850, 150, 320, 30)

  // --- hydraulics --------------------------------------------------------
  const pump = scene.add('pump', 'Pump', 300, 860, {
    strength: 3200,     // draft acceleration, cm/s² — ≈3 g at the impeller eye
    radius: 280,        // reaches every corner of the basin
    swirl: 0,
    spinUpMs: 600,
    maxRpm: 600,
  }, -1.05)

  // Sluice gate at the tray's low end. The plate is centred on its mount and
  // slides along the valve's own axis, so the mount is offset back up-slope and
  // above: that puts the *bottom edge* of the plate (local y = +gateWidth/2 →
  // world +18 px x, +50 px y) under the lip's surface line when shut, and the
  // top edge 87 px proud of the floor — a spillway that a full tray can overtop
  // back into the basin instead of flooding the world.
  const drain = scene.add('drain', 'Valve', 427, 670, {
    gateWidth: 102,
    travel: 130,
    responseMs: 800,
    normallyOpen: false,
  }, -0.1396)

  // Level sensor: sensor-only mode, measuring the pile against the sluice.
  // NOTE: a Tank's mount point is its *floor* — the interior extends upward.
  const tank = scene.add('tank', 'Tank', 600, 706, {
    width: 300,
    height: 90,
    wall: 12,
    geometry: false,
    capacityScale: 0.35, // calibrated: a brim-full tray reads ≈80 %
    fullAt: 62,
    filterMs: 120,
  })

  // --- electronics -------------------------------------------------------
  const mcu = scene.add('mcu', 'Controller', 300, 220, {
    filterMs: 80,
    rules: [
      {
        id: 'r-proximity',
        source: 'in0',
        target: 'out0',
        mode: 'below',
        threshold: 120,
        thresholdPin: 'in3',
        hysteresis: 10,
        debounceMs: 60,
        label: 'Pump while a target is inside the setpoint',
      },
      {
        id: 'r-full',
        source: 'in1',
        target: 'out0',
        mode: 'above',
        threshold: 60,
        hysteresis: 4,
        debounceMs: 200,
        invert: true,
        combine: 'and',
        label: 'Inhibit the pump above 64 % (release at 56 %)',
      },
      {
        id: 'r-drain',
        source: 'in1',
        target: 'out1',
        mode: 'above',
        threshold: 45,
        hysteresis: 5,
        debounceMs: 250,
        label: 'Open the sluice above 50 % (release at 40 %)',
      },
    ],
  })
  const relayPump = scene.add('relayPump', 'Relay', 700, 220, { mode: 'normally-open', operateMs: 24, releaseMs: 18 })
  const relayDrain = scene.add('relayDrain', 'Relay', 700, 380, { mode: 'normally-open', operateMs: 20, releaseMs: 16 })
  const sonar = scene.add('sonar', 'UltrasonicSensor', 110, 430, {
    range: 500,
    detectDistance: 260,   // loose gate: the *setpoint* lives on the dial

    noise: 0.4,
    filterMs: 40,
    triggerTargets: 'dynamic',
  }, 0)
  const dial = scene.add('dial', 'Potentiometer', 500, 320, { value: 200, maxValue: 400, noise: 0.1 })
  const lcd = scene.add('lcd', 'LCDDisplay', 950, 180, {
    template: 'LEVEL {value} %',
    template2: 'DIST {text} cm',
    decimals: 1,
    columns: 16,
  })
  const pumpLamp = scene.add('pumpLamp', 'Lamp', 950, 300, { color: 'green', size: 30 })
  const drainLamp = scene.add('drainLamp', 'Lamp', 1060, 300, { color: 'blue', size: 30 })
  const fullLamp = scene.add('fullLamp', 'Lamp', 1180, 480, { color: 'amber', size: 26, blinkHz: 1.5 })

  // A loose crate on an icy ramp for hands-on play.
  scene.wall(1290, 620, 260, 16, { material: 'metal', tilt: -6 })
  scene.add('freeCrate', 'Crate', 1260, 570, { size: 44, mass: 3, restitution: 0.2 })

  // --- wiring (the netlist) ---------------------------------------------
  scene.wire('sonar', 'distance', 'mcu', 'in0')      // A0 ← rangefinder
  scene.wire('tank', 'level', 'mcu', 'in1')          // A1 ← tray level
  scene.wire('dial', 'out', 'mcu', 'in3')            // A3 ← operator setpoint
  scene.wire('mcu', 'out0', 'relayPump', 'coil')     // D0 → pump relay
  scene.wire('mcu', 'out1', 'relayDrain', 'coil')    // D1 → sluice relay
  scene.wire('relayPump', 'switched', 'pump', 'power')
  scene.wire('relayPump', 'switched', 'pumpLamp', 'power')
  scene.wire('relayDrain', 'switched', 'drain', 'open')
  scene.wire('relayDrain', 'switched', 'drainLamp', 'power')
  scene.wire('tank', 'full', 'fullLamp', 'power')
  scene.wire('tank', 'level', 'lcd', 'value')
  scene.wire('sonar', 'distance', 'lcd', 'text')

  engine.simulation.fluid.maxParticles = 300
  engine.select(null)
  engine.fitView()
  return engine.simulation
}

/**
 * Demo 2 — "Intruder Alarm".
 *
 * A PIR cone watches a ramp; a crate slides through it under gravity, the
 * motion sensor latches HIGH, the controller drives a relay, and the relay
 * flashes a beacon. Line-of-sight means hiding behind the wall defeats it.
 */
export function buildIntruderAlarm(engine) {
  const scene = beginScene(engine, 'Intruder Alarm')

  scene.wall(320, 620, 900, 40)            // ground
  scene.wall(150, 500, 40, 280)            // left post
  scene.wall(1150, 520, 40, 240)           // right post
  scene.wall(140, 250, 300, 34, { tilt: -10, material: 'ice' }, 0) // ramp (slippery)
  scene.wall(560, 300, 26, 200)            // privacy wall (occludes the PIR)
  scene.wall(900, 430, 420, 30, { tilt: 6, material: 'ice' })

  const pir = scene.add('pir', 'PIRSensor', 700, 380, {
    range: 460,
    fov: 80,
    sensitivity: 22,
    holdMs: 1800,
    lineOfSight: true,
  }, Math.PI)
  const mcu = scene.add('mcu', 'Controller', 500, 120, {
    filterMs: 30,
    rules: [
      {
        id: 'r-alarm',
        source: 'in0',
        target: 'out0',
        mode: 'above',
        threshold: 0.5,
        hysteresis: 0.2,
        debounceMs: 40,
        label: 'Alarm while motion is latched',
      },
    ],
  })
  const relay = scene.add('relay', 'Relay', 780, 120, { mode: 'normally-open', operateMs: 12, releaseMs: 40 })
  const beacon = scene.add('beacon', 'Lamp', 1040, 190, { color: 'red', size: 44, blinkHz: 3 })
  const lcd = scene.add('lcd', 'LCDDisplay', 1080, 90, {
    template: 'MOTION {value}',
    template2: 'STATUS {text}',
    decimals: 0,
    unit: 'cm/s',
  })
  const crate = scene.add('crate', 'Crate', 190, 210, { size: 44, mass: 3, restitution: 0.15 })
  const reset = scene.add('reset', 'PushButton', 1250, 300, { pulseMs: 0 })

  scene.wire('pir', 'speed', 'mcu', 'in0')
  scene.wire('mcu', 'out0', 'relay', 'coil')
  scene.wire('relay', 'switched', 'beacon', 'power')
  scene.wire('pir', 'speed', 'lcd', 'value')
  scene.wire('reset', 'out', 'crate', 'teleport')

  engine.select(null)
  engine.fitView()
  return engine.simulation
}

/**
 * Demo 3 — "Cistern Level Control".
 *
 * The classic closed loop: a tank with a supply valve and a drain. The MCU
 * keeps the level inside a dead-band and the oscilloscope shows the resulting
 * sawtooth — proof that the hysteresis is doing its job.
 */
export function buildLevelControl(engine) {
  const scene = beginScene(engine, 'Cistern Level Control')

  // --- site plan ---------------------------------------------------------
  // The smallest interesting *closed* control loop: a supply that never stops,
  // a vessel that measures itself, and one actuator that is switched by the
  // level's Schmitt trigger — the classic two-position (bang-bang) controller.
  // The 20 % hysteresis is what stops the drain chattering at the setpoint.
  scene.wall(800, 900, 1600, 40)                      // ground
  scene.wall(420, 830, 40, 100)                       // sump left lip
  scene.wall(1200, 830, 40, 100)                      // sump right lip
  scene.wall(720, 780, 22, 160)                       // tank leg (left)
  scene.wall(880, 780, 22, 160)                       // tank leg (right)

  // The cistern itself: real geometry with a 64 px opening in its floor.
  const tank = scene.add('tank', 'Tank', 800, 700, {
    width: 300,
    height: 220,
    wall: 14,
    drainGap: 64,        // floor is split → a slide gate can plug the hole
    fullAt: 92,
    filterMs: 150,
  })

  // Slide gate: rotated 90°, so the plate lies *in* the floor and retracts
  // sideways (its local "up" is +x). Closed = plugged, open = holeshot.
  const drain = scene.add('drain', 'Valve', 800, 700, {
    gateWidth: 86,       // 11 px of overlap on each side of the 64 px hole
    travel: 104,
    responseMs: 900,
    normallyOpen: false,
  }, Math.PI / 2)

  // Supply: a tap that never closes, which is what makes the loop work.
  const source = scene.add('source', 'WaterSource', 800, 430, {
    rate: 10,
    speed: 120,
    spread: 5,
    nozzleLength: 34,
    manual: true,
  }, Math.PI / 2)

  // --- electronics -------------------------------------------------------
  const mcu = scene.add('mcu', 'Controller', 1240, 300, {
    filterMs: 120,
    rules: [
      {
        id: 'r-drain',
        source: 'in0',
        target: 'out0',
        mode: 'above',
        threshold: 50,
        thresholdPin: 'in1',   // A1 = operator setpoint
        hysteresis: 20,        // opens 20 % above the setpoint, closes 20 % below
        debounceMs: 250,
        label: 'Drain 20 % above setpoint, close 20 % below',
      },
      {
        id: 'r-low',
        source: 'in0',
        target: 'out1',
        mode: 'below',
        threshold: 12,
        hysteresis: 4,
        debounceMs: 200,
        label: 'Low-level alarm below 8 %',
      },
    ],
  })
  const relay = scene.add('relay', 'Relay', 1240, 470, { mode: 'normally-open', operateMs: 30, releaseMs: 25 })
  const dial = scene.add('dial', 'Potentiometer', 1240, 620, { value: 50, maxValue: 100, noise: 0.05 })
  const lcd = scene.add('lcd', 'LCDDisplay', 500, 300, {
    template: 'LEVEL {value} %',
    template2: 'SETPT {text}',
    decimals: 1,
    columns: 16,
  })
  const drainLamp = scene.add('drainLamp', 'Lamp', 620, 470, { color: 'blue', size: 30 })
  const lowLamp = scene.add('lowLamp', 'Lamp', 620, 560, { color: 'red', size: 30, blinkHz: 2 })
  const sumpLamp = scene.add('sumpLamp', 'Lamp', 1080, 700, { color: 'amber', size: 24 })

  // --- wiring ------------------------------------------------------------
  scene.wire('tank', 'level', 'mcu', 'in0')       // A0 ← measured level
  scene.wire('dial', 'out', 'mcu', 'in1')         // A1 ← operator setpoint
  scene.wire('mcu', 'out0', 'relay', 'coil')      // D0 → gate relay
  scene.wire('relay', 'switched', 'drain', 'open')
  scene.wire('relay', 'switched', 'drainLamp', 'power')
  scene.wire('mcu', 'out1', 'lowLamp', 'power')   // D1 → alarm lamp
  scene.wire('tank', 'level', 'lcd', 'value')
  scene.wire('dial', 'out', 'lcd', 'text')
  scene.wire('tank', 'full', 'sumpLamp', 'power')

  engine.simulation.fluid.maxParticles = 320
  engine.select(null)
  engine.fitView()
  return engine.simulation
}

/**
 * Demo 4 — "Physics Showroom": no mechatronics, just the engine showing off
 * stacking, restitution, spatial-hash stress (400 droplets) and a motor-driven
 * paddle wheel.
 */
export function buildPhysicsShowroom(engine) {
  const scene = beginScene(engine, 'Physics Showroom')

  scene.wall(800, 800, 1300, 40)               // floor
  scene.wall(130, 500, 40, 600)                // left wall
  scene.wall(1460, 500, 40, 600)               // right wall
  scene.wall(430, 620, 300, 24, { tilt: 14, material: 'ice' })
  scene.wall(500, 720, 420, 24, { tilt: -8, material: 'rubber' })
  scene.wall(1080, 560, 320, 24, { tilt: 10, material: 'metal' })

  // Stacked crates: the broad phase + warm-started solver keep this stable.
  const stackX = 820
  for (let i = 0; i < 7; i++) {
    scene.add(null, 'Crate', stackX + (i % 2) * 3, 780 - i * 42, {
      size: 40,
      mass: 2 + i * 0.3,
      friction: 0.6,
      restitution: 0.05,
    })
  }

  // Bouncy spheres (high restitution crates) doing a Newton's-cradle run.
  for (let i = 0; i < 3; i++) {
    scene.add(null, 'Crate', 260 + i * 60, 700 - i * 30, { size: 34, mass: 1.2, restitution: 0.85, friction: 0.05 })
  }

  // Big pool of water: exercises fluid-fluid contacts in the spatial hash.
  scene.water(1080, 700, 260, 300, 220)

  // Motor-driven paddle wheel sitting in the water.
  const motor = scene.add('motor', 'Motor', 1080, 420, { maxRpm: 200, torque: 60000, radius: 40, responseMs: 600 })
  const switchA = scene.add('switch', 'ToggleSwitch', 300, 200, { on: true })
  scene.wire('switch', 'out', 'motor', 'power')

  engine.simulation.fluid.maxParticles = 300
  engine.select(null)
  engine.fitView()
  return engine.simulation
}

/** Demo 5 — "Relay Lab": the smallest useful circuit (switch → relay → lamp). */
export function buildRelayLab(engine) {
  const scene = beginScene(engine, 'Relay Lab')
  scene.wall(800, 620, 1200, 40)
  const toggle = scene.add('toggle', 'ToggleSwitch', 500, 420, { on: false })
  const relay = scene.add('relay', 'Relay', 800, 420, { mode: 'normally-open', operateMs: 40, releaseMs: 40 })
  const lamp = scene.add('lamp', 'Lamp', 1100, 420, { color: 'amber', size: 40, blinkHz: 0 })
  const lcd = scene.add('lcd', 'LCDDisplay', 800, 250, {
    template: 'COIL {text}',
    template2: 'CONTACT {value}',
    decimals: 0,
  })
  scene.wire('toggle', 'out', 'relay', 'coil')
  scene.wire('relay', 'switched', 'lamp', 'power')
  scene.wire('toggle', 'out', 'lcd', 'text')
  scene.wire('relay', 'cycles', 'lcd', 'value')
  engine.fitView()
  return engine.simulation
}

export const DEMOS = [
  {
    id: 'proximity-pump',
    name: 'Proximity Pump',
    tagline: 'Ultrasonic ranging closes the loop on a water pump — the whitepaper circuit.',
    icon: '≪',
    accent: '#38bdf8',
    difficulty: 'Flagship',
    build: buildProximityPump,
  },
  {
    id: 'intruder-alarm',
    name: 'Intruder Alarm',
    tagline: 'PIR cone + line-of-sight occlusion + latching relay driving a beacon.',
    icon: '◠',
    accent: '#facc15',
    difficulty: 'Intermediate',
    build: buildIntruderAlarm,
  },
  {
    id: 'cistern-control',
    name: 'Cistern Level Control',
    tagline: 'Dead-band level control with valve, drain pump and a live scope trace.',
    icon: '▽',
    accent: '#2dd4bf',
    difficulty: 'Intermediate',
    build: buildLevelControl,
  },
  {
    id: 'relay-lab',
    name: 'Relay Lab',
    tagline: 'The smallest circuit that teaches relay FSM, operate time and cycle counting.',
    icon: '⊟',
    accent: '#f472b6',
    difficulty: 'Starter',
    build: buildRelayLab,
  },
  {
    id: 'physics-showroom',
    name: 'Physics Showroom',
    tagline: 'Stacks, restitution and 300 fluid particles — pure engine, no wiring.',
    icon: '▤',
    accent: '#94a3b8',
    difficulty: 'Sandbox',
    build: buildPhysicsShowroom,
  },
]

export function buildDemo(engine, id) {
  const demo = DEMOS.find((d) => d.id === id)
  if (!demo) throw new Error(`Unknown demo "${id}"`)
  return demo.build(engine)
}

export { Vec2 }
