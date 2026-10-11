import { Engine } from '../engine/Engine.js'
import { buildDemo, DEMOS } from '../engine/demos.js'

/**
 * Bridge between the vanilla engine and React.
 *
 * **Ownership rule.** The engine owns the canvas, the rAF loop and every
 * mutable simulation value. React owns only the *chrome*: which demo is
 * selected, which component is inspected, how many undo steps exist, and the
 * handful of numbers shown in the status bar. Nothing that changes at 60 Hz
 * ever becomes React state — the status bar samples the engine's stats on a
 * timer instead, so a busy simulation can never trigger a render storm.
 *
 * The returned object is intentionally imperative: `start`, `pause`, `step`,
 * `load`, `save`, … map 1:1 onto engine calls.
 */
export function createEngineHost({ canvas, onEvent }) {
  const engine = new Engine({ canvas })
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const subscriptions = [
    ['stats', onEvent],
    ['selection:changed', emit],
    ['history:changed', emit],
    ['scene:loaded', emit],
    ['scene:reset', emit],
    ['component:changed', emit],
    ['running:changed', emit],
  ]
  for (const [event, handler] of subscriptions) {
    if (handler) engine.on(event, (payload) => handler(event, payload))
  }

  engine.start()
  buildDemo(engine, DEMOS[0].id)

  return {
    engine,
    demos: DEMOS,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      engine.dispose()
      listeners.clear()
    },
    start: () => engine.setRunning(true),
    pause: () => engine.setRunning(false),
    toggle: () => engine.toggleRunning(),
    step: () => engine.stepOnce(),
    reset: () => engine.resetScene(),
    undo: () => engine.undo(),
    redo: () => engine.redo(),
    fit: () => engine.fitView(),
    loadDemo: (id) => {
      buildDemo(engine, id)
      return engine
    },
    setTimeScale: (scale) => engine.setTimeScale(scale),
    select: (id) => engine.select(id),
  }
}
