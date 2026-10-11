import { Controller } from './components/Controller.js'
import { UltrasonicSensor } from './components/UltrasonicSensor.js'
import { PIRSensor } from './components/PIRSensor.js'
import { Relay } from './components/Relay.js'
import { Pump } from './components/Pump.js'
import { Motor } from './components/Motor.js'
import { Valve } from './components/Valve.js'
import { WaterSource } from './components/WaterSource.js'
import { Tank } from './components/Tank.js'
import { LCDDisplay, Lamp } from './components/Display.js'
import { ToggleSwitch, PushButton, Potentiometer } from './components/Switches.js'
import { Wall, Crate } from './components/Fixtures.js'

/**
 * Component registry.
 *
 * A single source of truth mapping the serialized `type` string to the ES6
 * class, used by:
 *   * the React parts palette (auto-generated from this list),
 *   * `deserialize()` (instantiate the right class from a payload),
 *   * the Zod schema on the server (rejects unknown types at the door).
 *
 * Adding a part = write the class + add it here. No other file changes.
 */
export const COMPONENTS = [
  Controller,
  UltrasonicSensor,
  PIRSensor,
  Relay,
  Pump,
  Motor,
  Valve,
  WaterSource,
  Tank,
  LCDDisplay,
  Lamp,
  ToggleSwitch,
  PushButton,
  Potentiometer,
  Wall,
  Crate,
]

const REGISTRY = new Map(COMPONENTS.map((Ctor) => [Ctor.type, Ctor]))

export const componentTypes = COMPONENTS.map((C) => C.type)

export function getComponentClass(type) {
  return REGISTRY.get(type) ?? null
}

export function createComponent(type, options = {}) {
  const Ctor = getComponentClass(type)
  if (!Ctor) throw new Error(`Unknown component type "${type}"`)
  return new Ctor(options)
}

/** Palette metadata consumed by the React sidebar. */
export function paletteGroups() {
  const groups = new Map()
  for (const Ctor of COMPONENTS) {
    if (Ctor.hidden) continue
    if (!groups.has(Ctor.group)) groups.set(Ctor.group, [])
    groups.get(Ctor.group).push({
      type: Ctor.type,
      label: Ctor.label,
      accent: Ctor.accent,
      icon: Ctor.icon,
      description: Ctor.description,
      group: Ctor.group,
      ports: Ctor.ports,
    })
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}

export function describeType(type) {
  const Ctor = getComponentClass(type)
  if (!Ctor) return null
  return {
    type: Ctor.type,
    label: Ctor.label,
    group: Ctor.group,
    accent: Ctor.accent,
    icon: Ctor.icon,
    description: Ctor.description,
    ports: Ctor.ports,
    controls: Ctor.controls,
    phase: Ctor.phase,
  }
}

export const KINDS = {
  sensor: COMPONENTS.filter((C) => C.group === 'Sensors').map((C) => C.type),
}
