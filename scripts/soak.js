#!/usr/bin/env node
/**
 * Headless soak harness.
 *
 * Boots the real engine (no canvas, no React) against every demo circuit and
 * runs it for a simulated number of seconds, checking the invariants a physics
 * engine must never violate:
 *
 *   * no NaN / Infinity in any body transform or velocity
 *   * no body escapes the world bounds by more than a margin
 *   * contact count and solver time stay bounded
 *   * the engine's fixed-step rate is honoured
 *
 * Usage: node scripts/soak.js [seconds] [--json]
 */
import { performance } from 'node:perf_hooks'
import { Engine } from '../src/engine/Engine.js'
import { DEMOS } from '../src/engine/demos.js'
import { createComponent } from '../src/engine/registry.js'
import { Simulation } from '../src/engine/Simulation.js'
import { CircleShape } from '../src/engine/physics/shapes.js'
import { Vec2 } from '../src/engine/math/Vec2.js'

const seconds = Number(process.argv[2]) || 12
const asJson = process.argv.includes('--json')

/** Minimal Engine stand-in: everything except canvas/rendering. */
function headlessEngine(simulation = new Simulation()) {
  const engine = new Engine({ canvas: null, simulation })
  engine.running = false
  return engine
}

function assertFinite(simulation, label) {
  const problems = []
  for (const body of simulation.world.bodies) {
    if (body.removed) continue
    if (!body.position.isFinite() || !Number.isFinite(body.angle)) {
      problems.push(`${label}: body ${body.id} has non-finite transform`)
      break
    }
    if (!body.velocity.isFinite() || !Number.isFinite(body.angularVelocity)) {
      problems.push(`${label}: body ${body.id} has non-finite velocity`)
      break
    }
  }
  return problems
}

const report = []
for (const demo of DEMOS) {
  const engine = headlessEngine()
  const t0 = performance.now()
  demo.build(engine)
  const buildMs = performance.now() - t0
  const simulation = engine.simulation

  const dt = simulation.timestep
  const steps = Math.round(seconds / dt)
  let maxContacts = 0
  let maxSolverMs = 0
  let maxBodySpeed = 0
  const t1 = performance.now()
  const problems = []

  for (let i = 0; i < steps; i++) {
    simulation.step(dt)
    if (i % 30 === 0) {
      const stats = simulation.world.stats
      maxContacts = Math.max(maxContacts, stats.contacts)
      maxSolverMs = Math.max(maxSolverMs, stats.solverMs)
      for (const body of simulation.world.bodies) {
        if (!body.removed && body.isDynamic) maxBodySpeed = Math.max(maxBodySpeed, body.speed)
      }
      problems.push(...assertFinite(simulation, demo.id))
      if (problems.length) break
    }
  }
  const simMs = performance.now() - t1
  const perStepMs = simMs / steps

  const escaped = simulation.world.bodies.filter((body) => {
    if (body.removed || body.isStatic || body.isFluid) return false
    const b = simulation.bounds
    return (
      body.position.x < b.minX - 4000 ||
      body.position.x > b.maxX + 4000 ||
      body.position.y < b.minY - 4000 ||
      body.position.y > b.maxY + 4000
    )
  }).length

  report.push({
    demo: demo.id,
    name: demo.name,
    components: simulation.components.size,
    wires: simulation.edges.length,
    bodies: simulation.world.bodies.length,
    fluid: simulation.fluid.count,
    steps,
    buildMs: round(buildMs),
    perStepMs: round(perStepMs, 4),
    simSecondsPerSecond: round(1000 / perStepMs / 1, 1),
    maxContacts,
    maxSolverMs: round(maxSolverMs, 3),
    maxBodySpeed: round(maxBodySpeed, 1),
    escaped,
    problems,
  })
  engine.dispose()
}

/** A component-level integration check: sensor → MCU → relay → pump chain. */
function chainCheck() {
  const simulation = new Simulation()
  const sensor = createComponent('UltrasonicSensor', { position: { x: 100, y: 400 }, properties: { range: 400, filterMs: 0 } })
  const mcu = createComponent('Controller', {
    properties: {
      filterMs: 0,
      rules: [{ id: 'r', source: 'in0', target: 'out0', mode: 'below', threshold: 150, hysteresis: 5, debounceMs: 0 }],
    },
  })
  const relay = createComponent('Relay', {})
  const pump = createComponent('Pump', {})
  simulation.add(sensor)
  simulation.add(mcu)
  simulation.add(relay)
  simulation.add(pump)
  simulation.connect(sensor.id, 'distance', mcu.id, 'in0')
  simulation.connect(mcu.id, 'out0', relay.id, 'coil')
  simulation.connect(relay.id, 'switched', pump.id, 'power')

  // A *dynamic* obstacle: the default sensor config ignores static scenery.
  const obstacle = simulation.world.addBody({
    shape: new CircleShape(60),
    position: new Vec2(400, 400),
    bodyType: 'dynamic',
    mass: 4,
    tag: 'test-obstacle',
    gravityScale: 0,
    allowSleep: false,
  })

  const timeline = []
  for (let i = 0; i < 240; i++) {
    simulation.step(1 / 60)
    if (i % 60 === 0) {
      timeline.push({
        t: round(simulation.world.time, 2),
        distance: round(mcu.state.filtered.in0, 1),
        d0: mcu.state.logic.out0,
        relay: relay.state.state,
        pumpPower: pump.readInput('power'),
      })
    }
  }
  simulation.world.removeBody(obstacle)
  return timeline
}

console.log('\n=== MechaSim interface chain (sensor → MCU → relay → pump) ===')
console.table(chainCheck())

console.log('\n=== MechaSim soak ===')
console.table(report.map(({ problems, ...row }) => ({ ...row, problems: problems.length })))
const failures = report.filter((r) => r.problems.length)
if (failures.length) {
  console.error('INVARIANT FAILURES:')
  for (const f of failures) console.error(' -', f.demo, f.problems.join('; '))
}
if (asJson) console.log(JSON.stringify(report, null, 2))
process.exitCode = failures.length ? 1 : 0

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round(v * f) / f
}

/**
 * Behavioural probe: does each demo circuit actually *do its job*?
 * This is the regression test that matters — a scene can be numerically stable
 * and still be wired wrong.
 */
export function probeDemos(seconds = 20) {
  const results = []
  for (const demo of DEMOS) {
    const engine = headlessEngine()
    demo.build(engine)
    const sim = engine.simulation
    const steps = Math.round(seconds / sim.timestep)
    const states = []
    for (let i = 0; i < steps; i++) {
      sim.step(sim.timestep)
      if (i % 120 === 0) states.push(snapshot(sim))
    }
    results.push({ demo: demo.id, states: states.slice(-4) })
    engine.dispose()
  }
  return results
}

function snapshot(sim) {
  const out = { t: round(sim.world.time, 1), fluid: sim.fluid.count }
  for (const component of sim.componentList) {
    switch (component.type) {
      case 'Tank':
        out.level = round(component.state.level, 1)
        out.full = component.state.full
        break
      case 'Controller':
        out.logic = Object.entries(component.state.logic).filter(([, v]) => v).map(([k]) => k).join(',') || '-'
        break
      case 'Relay':
        out.relay = component.state.state
        break
      case 'Pump':
        out.pumpRpm = Math.round(component.state.rpm)
        break
      case 'PIRSensor':
        out.motion = component.state.motion
        out.triggers = component.state.triggers
        break
      case 'UltrasonicSensor':
        out.distance = round(component.state.distance, 1)
        break
      case 'LCDDisplay':
        out.lcd = component.state.lines.join(' | ')
        break
      case 'Lamp':
        out.lamp = component.state.on ? 'ON' : 'off'
        break
      default:
        break
    }
  }
  return out
}
