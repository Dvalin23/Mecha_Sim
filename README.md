<div align="center">

# MechaSim

**A browser-native 2D physics engine and virtual mechatronics bench.**

Build a machine out of rigid bodies and water, wire it up like a PLC panel —
sensors, a controller, relays, motorised actuators, an I²C display — then watch
the physics and the control loop argue with each other in real time.

`vanilla ES6 engine` · `React overlay` · `Node + Express + Zod pipeline`

</div>

---

## What it is

MechaSim is two machines in one page:

| Layer | What it is | Where it lives |
| --- | --- | --- |
| **Physics** | Fixed-timestep rigid-body + particle solver: spatial-hash broad phase, SAT narrow phase, impulse resolution with warm starting | `src/engine/physics/` |
| **Mechatronics** | Cyclic-executive state machines — sensors scan, controllers run ladder rules, relays switch, actuators move, displays render | `src/engine/components/` |
| **Fluid** | 150–260 pooled droplets with drag, surface friction and a pump model that can actually move water | `src/engine/FluidSystem.js` |
| **UI** | React chrome around a canvas the framework never touches | `src/ui/` |
| **Pipeline** | Serialize a live simulation to JSON, validate it with Zod, store it, share it by short link | `server/`, `shared/schema.js` |

The engine has no idea React exists. React has no idea a simulation is running
except through one `CustomEvent` and a 4 Hz stats tick.

## Quick start

```bash
npm install
npm run dev          # → http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite in middleware mode + Express on one port (the only server you need) |
| `npm start` | Production mode: builds nothing, serves `dist/` and the API |
| `npm test` | 48 unit tests — physics, mechatronics, serialization, validation |
| `npm run smoke` | Boots the **real React app** in jsdom on a stubbed canvas and drives frames |
| `node scripts/soak.js 30` | Headless soak: builds every demo, reports ms/step, contacts, escapes |

## The physics engine

**Fixed timestep with an accumulator.** The render loop never feeds raw frame
deltas to the solver. `Engine.frame()` accumulates wall time, drains it in
`1/60 s` steps, clamps a backgrounded tab to `maxStepsPerFrame`, and reports the
shed backlog as `droppedSteps`. Integration is semi-implicit Euler
(`v += (F/m)·Δt`, then `p += v·Δt`), so a falling body's trajectory is exact
under gravity and does not gain energy as the timestep wobbles.

**Broad phase: spatial hash.** Bodies are rasterised into a uniform grid
(`cellSize 96`). Anything whose AABB would smear across more than 256 cells is
tagged *global* (level walls, the ground slab) and clipped against candidates
instead — the classic "one huge polygon in every cell" pathology, avoided.
Pairs are deduplicated with a packed integer key, and static/static pairs never
reach the narrow phase.

**Narrow phase: SAT.** Circle–circle, circle–polygon and polygon–polygon, with
face clipping producing two-point manifolds for flat-on-flat contact (which is
what stops boxes jittering on the floor). The **contact point is the closest
point on the contacted face**, not an average of clipped points; deep
penetration uses the deepest vertex.

**Resolution: impulses with warm starting.** 8 iterations, Baumgarte bias
`min(0.22·invDt·overlap, 600)`, restitution threshold, friction from
`sqrt(μa·μb)` and inverse-mass/inverse-inertia scaling throughout. Penetration is
`max(0, −separation − allowedPenetration)`.

> Three bugs in this file are worth the price of admission, all found by
> measurement rather than inspection: deep-penetration contacts were using the
> *contacted face's first vertex* as the reference point; the Baumgarte bias had
> a sign error; and `penetration = max(0, separation + allowed)` was always zero,
> so nothing ever pushed a body back out. The fix for the first is
> `clampTravelPerStep`. A 5 px droplet dropped inside a 16 px slab now stays on
> top of it (`tests/physics.test.js`).

**Fluid** is a pooled set of small circles with zero rotational inertia. That
last part is not a detail: giving droplets inertia made them *roll uphill* on an
8° ice chute, because a bead's contact friction produces a torque that a uniform
disc will happily convert back into propulsion. `inertia 0 / invInertia 0`,
plus a quadratic drag term, gives water that behaves like water.

## The mechatronics layer

Every component is a state machine evaluated in **phases**, in one order, every
step:

```
SENSOR → LOGIC → CONTROLLER → ACTUATOR → DISPLAY
```

That single design choice buys physical honesty for free: a signal costs exactly
one step of latency per hop, a relay cannot close in the same tick its coil
energises, and an LCD shows the value that was resolved *before* it ran — which
is what a real I²C backpack does. Tests assert the latency, not just the value.

- **Controller** — a cyclic executive: EMA filter → per-rule Schmitt trigger
  (`above`/`below`/`window`/`toggle`/`always`) → per-pin `combine: or|and` →
  optional invert → debounce. `thresholdPin` makes a setpoint remotely
  adjustable, which is how the level controller gets its dead band.
- **Ultrasonic sensor** — raycast, Euclidean distance, and a hardware echo model
  that limits how fast the reading can slew (34 400 cm/s round trip), so a beam
  sweeping past a corner ghosts exactly like the real thing.
- **PIR sensor** — triangular cone query, tracks each body's Δposition between
  steps, `speed > sensitivity` latches `motion` for `holdMs`. A static body in
  the cone is not motion.
- **Relay** — OPEN/CLOSED FSM with separate operate and release times, chatter
  detection and a transition counter.
- **LCD display** — canvas-rendered panel with `ctx.fillText()`, template
  substitution (`{value}`, `{unit}`, `\n`), backlight, blinking cursor and its
  own refresh lag.
- **Valve / Motor / Pump / WaterSource / Tank / Lamp / switches / potentiometer**
  — actuators that consume the same signal discipline, and a `Wall`/`Crate`
  pair for structure and props.

## Serialization and the sharing pipeline

The simulation is a graph of live objects: bodies hold references to their
components, a relay's output is a motor's input, and a feedback wire makes the
whole thing cyclic. `serialize()` strips methods, flattens every reference into
a UUID string, and emits:

```jsonc
{
  "simulationId": "sim_4i4drk66",
  "environment": { "gravity": 981, "timestep": 0.0166 },
  "nodes": [{ "id": "pump_x9f2", "type": "Pump", "x": 312, "y": 850,
              "rotation": -1.42, "properties": { "strength": 4000 } }],
  "connections": [{ "from": { "node": "mcu_1", "port": "out1" },
                    "to":   { "node": "valve_7", "port": "open" } }],
  "fluid": [{ "x": 250, "y": 850, "count": 150, "spreadX": 180, "spreadY": 30 }]
}
```

`deserialize()` reinstantiates the ES6 classes by `"type"`, rebuilds the
connections map from the string ids, and replays the water fills. 150 droplets
cost four numbers on the wire instead of 300 coordinates.

`POST /api/projects/save` validates that payload with **Zod** before it touches
disk — including per-rule validation of controller logic, which is the one place
a payload could try to steer the engine's control flow. Malformed input gets
`422` and a list of `{path, message}` issues; the browser runs the *same* schema,
so an invalid scene never leaves the page. Valid saves return a short link
(`/s/<id>`) that reloads the whole machine, water and wiring included.

## The flagship demo: pumped storage

`proximity-pump` is a closed-loop energy store. A rangefinder watches for a
target; while it sees one, the MCU runs an impeller. The impeller draws water out
of the sump up a standpipe and throws it onto a tilted deck; the deck drains
through a sluice gate into a return chute; the chute feeds the sump. A float
sensor on the deck closes the loop: above the setpoint with hysteresis, the MCU
shuts the pump down and opens the sluice.

**Measured: 32 sluice cycles in 300 s, period 9.4 s, 150/150 droplets
accounted for, 1.85 ms per step with 174 bodies.**

Getting there took six station layouts and three pump models, and the reasons
are worth writing down because they are the difference between a demo that
*looks* alive and one that does work:

| Model | What it did | Why it failed |
| --- | --- | --- |
| Uniform radial force field | pulled water toward a nozzle | **A conveyor, not a pump.** Water it could not blow away it *held*: 150 droplets parked motionless on a 10° ice chute, 44 packed against a closed sluice plate, the level line flat at 26.3 % for 350 s. An engine that can hold water up forever has no energy budget, so no machine built on it can ever be shown to work. |
| Suction well + velocity-blend eye | drew water in, launched it | The intake worked; the jet was whatever the field made of it, and the loop never closed (deck 0 → 18.6 % in 300 s, then flat). |
| **Geometric intake + ballistic launch** | nearest-first intake inside the eye, release *past* the housing, velocity set for a `v`-speed parabola | Repeatable cycles — and the trajectory is now a designed quantity (`v = √(2·a·d)`) instead of an emergent artefact. |

The station geometry then had to obey one rule: **nothing the pump can reach may
face uphill, and nothing downstream of the launch may trap water out of reach.**
The last two bugs were exactly that — a basin wall standing 54 px proud of the
deck, damming the only route to the sluice (150 droplets piled against it while
the gate sat open at x 1004 with nothing to release), and a return chute that
stopped 9 px past the deck's lip, so water overshot it and stranded 51 droplets
on the floor outside the draft radius. Both are described in place in
`src/engine/demos.js`.

## The other demos

- **intruder-alarm** — PIR + ultrasonic + relay + lamp: motion in the cone
  latches an alarm with a hold time and a reset path.
- **cistern-control** — the classic: tank, supply valve, drain valve, level
  rules with a 20 % dead band, and a dial for the setpoint. 9 drain events per
  240 s.
- **relay-lab** — the smallest honest circuit: button → relay → motor, so the
  one-step latency per hop is visible.
- **physics-showroom** — 279 bodies: stacks, ramps, a friction course, a
  restitution row, 260 droplets. A stress test you can watch.

## Rendering and the React boundary

`Renderer` draws grid → fluid → wires → components → debug → overlay, with
interpolation between physics states (`alpha`) so motion is smooth at any
refresh rate. `Input` owns the gesture priority (wire > actuate > grab > move >
pan), marquee selection and the keyboard map.

React owns: the toolbar, the component palette (generated from the same registry
the engine uses — there is no second list of parts to keep in sync), the
inspector, and the status bar. Inspector controls are **uncontrolled inputs that
write straight onto the vanilla instances** (`engine.updateProperty(component,
key, value)`), so dragging a slider does not re-render the tree on every frame;
canvas → React selection flows through `CustomEvent('entitySelected')`.

## Engineering notes

- **`npm run smoke` runs the real app.** jsdom plus a context stub that accepts
  every 2D call, a manual `requestAnimationFrame` queue, React mounted into
  `#root`: the test asserts the toolbar rendered, the palette came from the
  registry, a real simulation ran under the canvas and the stubbed context saw
  thousands of draw calls. The render path is the one thing a headless physics
  probe cannot cover, so it gets its own harness.
- **Tests found bugs that inspection had missed**: the axis-aligned raycast
  (parallel-face slab test inverted, so a rangefinder aimed straight at a wall
  reported nothing), polygon inertia (fan sum divided by 6 instead of 12, and
  `Math.abs` per edge destroying the cancellation for off-origin polygons), undo
  history (snapshots pushed *after* each mutation, so the first undo was a
  no-op), and a normally-closed relay that booted showing OPEN.
- **The smoke harness earned its keep too.** jsdom reports an exception thrown
  inside an event listener as a `jsdomError`, which never reaches
  `window.console.error` — so the harness subscribes to the virtual console and
  fails on it. That is how `Palette`'s click-to-add was caught: the handler
  declared `const hostRef = hostRef.current`, which shadows the ref inside its
  own scope and threw a TDZ `ReferenceError` on every palette click in the real
  app. Clicking a part now adds it (the check asserts 24 → 25 components).
- **`payloadSizeLimit` and the rules schema are shared** between the browser and
  the server. Validation is not a server-side detail bolted on afterwards; the
  same module runs in both places.
