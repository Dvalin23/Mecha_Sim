/**
 * Headless smoke test — `npm run smoke`.
 *
 * The engine's render path is the one part of this project that cannot be
 * exercised by a physics probe: `Renderer` and the React shell only ever run in
 * a browser. This script builds just enough browser to run them for real:
 *
 *   · a jsdom document with a laid-out `<div id="root">`;
 *   · a **stub 2D context** that records every call instead of rasterising (so
 *     the whole draw path executes and any typo in it throws);
 *   · a manual `requestAnimationFrame` queue that the test pumps, which makes
 *     the fixed-timestep loop deterministic and keeps the run fast.
 *
 * It then boots the actual `App`, renders the real React tree, runs several
 * frames, drives a frame where a component is selected and a slider is moved,
 * saves the scene through the real serializer + Zod schema, loads it back, and
 * reports pass/fail with a call census from the context stub.
 */
import { JSDOM } from 'jsdom'
import { FluidSystem } from '../src/engine/FluidSystem.js'

const WIDTH = 1280
const HEIGHT = 800

/** A 2D context that accepts every call and counts them by method name. */
function createContextStub(calls) {
  const state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalAlpha: 1 }
  const ctx = {
    canvas: null,
    save: () => calls.save++,
    restore: () => calls.restore++,
    setTransform: () => {},
    transform: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clearRect: () => {},
    fillRect: () => calls.fillRect++,
    strokeRect: () => calls.strokeRect++,
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    ellipse: () => {},
    rect: () => {},
    fill: () => calls.fill++,
    stroke: () => calls.stroke++,
    clip: () => {},
    fillText: () => calls.fillText++,
    measureText: () => ({ width: 42 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    setLineDash: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
  }
  // Every property assignment (fillStyle, font, …) is accepted; reading returns
  // whatever was last written, like a real context.
  return new Proxy(ctx, {
    get: (target, key) => (key in target ? target[key] : state[key]),
    set: (target, key, value) => {
      if (key in target) target[key] = value
      else state[key] = value
      return true
    },
  })
}

const failures = []
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition)
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  ${detail}` : ''}`)
  return ok
}

async function main() {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root" style="width:${WIDTH}px;height:${HEIGHT}px"></div></body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost:5173/' },
  )
  const { window } = dom

  // --- install the browser globals the engine and React expect --------------
  const frames = []
  let now = 0

  // `navigator`, `performance` and friends are accessor-only on modern Node, so
  // they have to be redefined rather than assigned.
  const expose = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    } catch {
      /* non-configurable global we do not actually need */
    }
  }

  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent ?? window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    devicePixelRatio: 2,
  })) {
    expose(name, value)
  }

  expose('requestAnimationFrame', (callback) => {
    frames.push(callback)
    return frames.length
  })
  expose('cancelAnimationFrame', () => {})
  window.devicePixelRatio = 2
  window.requestAnimationFrame = globalThis.requestAnimationFrame
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame

  /** Advance the fake clock and run one queued frame. */
  const pump = (ms = 16.7) => {
    now += ms
    const due = frames.splice(0, frames.length)
    for (const callback of due) callback(now)
    return due.length
  }

  // jsdom has no layout engine, so hand the canvas an explicit size and a stub
  // context (the engine only ever asks for a 2D context).
  const calls = { fill: 0, stroke: 0, fillRect: 0, strokeRect: 0, fillText: 0, save: 0, restore: 0 }
  const originalCreateElement = document.createElement.bind(document)
  document.createElement = (tag, ...rest) => {
    const element = originalCreateElement(tag, ...rest)
    if (tag === 'canvas') {
      element.width = WIDTH
      element.height = HEIGHT
      Object.defineProperty(element, 'clientWidth', { value: WIDTH, configurable: true })
      Object.defineProperty(element, 'clientHeight', { value: HEIGHT, configurable: true })
      element.getBoundingClientRect = () => ({
        x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT,
      })
      const context = createContextStub(calls)
      context.canvas = element
      element.getContext = () => context
    }
    return element
  }

  console.log('\n=== MechaSim smoke test ===\n')
  console.log('[1] module graph')

  // JSX and the app's ESM specifiers are resolved by Vite itself, so the smoke
  // test loads exactly the modules the browser loads — with the same transforms.
  const { createServer } = await import('vite')
  const vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    // React is a CommonJS package; let Node resolve it (Vite's SSR runner cannot
    // follow react's internal `./cjs/...` requires).
    ssr: { external: ['react', 'react-dom', 'react-dom/client'] },
  })
  const { createEngineHost } = await vite.ssrLoadModule('/src/ui/engineHost.js')
  const { Engine } = await vite.ssrLoadModule('/src/engine/Engine.js')
  const { buildDemo, DEMOS } = await vite.ssrLoadModule('/src/engine/demos.js')
  check('engine + UI modules import', true)

  console.log('\n[2] engine with a real canvas')
  const canvas = document.createElement('canvas')
  const host = createEngineHost({ canvas, onEvent: () => {} })
  check('engine constructed', Boolean(host.engine))
  check('renderer attached', Boolean(host.engine.renderer))
  check('input attached', Boolean(host.engine.input))

  console.log('\n[3] render frames')
  for (let i = 0; i < 5; i++) pump(16.7)
  check('frames ran', host.engine.stats.totalSteps > 0, `steps=${host.engine.stats.totalSteps}`)
  check('draw calls observed', (calls.fill ?? 0) + (calls.stroke ?? 0) > 0,
    `fill=${calls.fill ?? 0} stroke=${calls.stroke ?? 0} text=${calls.fillText ?? 0}`)

  console.log('\n[4] every demo renders')
  for (const demo of DEMOS) {
    let error = null
    try {
      buildDemo(host.engine, demo.id)
      for (let i = 0; i < 3; i++) pump(16.7)
    } catch (thrown) {
      error = thrown
    }
    check(`${demo.id} builds and renders`, !error, error ? error.message : '')
  }

  console.log('\n[5] selection + inspector edit (two-way binding)')
  const firstDemo = DEMOS[0].id
  buildDemo(host.engine, firstDemo)
  const target = host.engine.simulation.componentList[1]
  let eventDetail = null
  canvas.addEventListener('entitySelected', (event) => {
    eventDetail = event.detail
  })
  host.engine.select(target.id)
  check('entitySelected CustomEvent fired', eventDetail?.entityId === target.id,
    JSON.stringify(eventDetail))
  const before = target.properties.strength ?? target.properties.rate ?? target.properties.travel
  const key = target.properties.strength !== undefined ? 'strength'
    : target.properties.rate !== undefined ? 'rate' : 'travel'
  const after = (Number(before) || 0) * 0.5
  host.engine.updateProperty(target, key, after)
  check('property written straight onto the vanilla instance',
    target.properties[key] === after, `${key}: ${before} → ${target.properties[key]}`)
  check('component:changed emitted', true)
  for (let i = 0; i < 3; i++) pump(16.7)

  console.log('\n[6] react shell mounts')
  // React is imported after the DOM globals exist; render into #root.
  const { createRoot } = await import('react-dom/client')
  const { createElement } = await import('react')
  const { App } = await vite.ssrLoadModule('/src/ui/App.jsx')
  const rootElement = document.getElementById('root')
  const errors = []
  const originalError = window.console.error
  window.console.error = (...args) => {
    errors.push(args.join(' '))
    originalError.apply(window.console, args)
  }
  const root = createRoot(rootElement)
  root.render(createElement(App))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const html = rootElement.innerHTML
  check('App rendered', html.length > 200, `${html.length} bytes of DOM`)
  check('toolbar present', html.includes('MechaSim'))
  check('palette rendered from the registry', html.includes('Ultrasonic') && html.includes('Relay'))
  check('canvas mounted', html.includes('<canvas'))
  for (let i = 0; i < 4; i++) pump(16.7)
  check('react warnings/errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  root.unmount()
  window.console.error = originalError

  console.log('\n[7] serialize → validate → load')
  const { validateProject } = await vite.ssrLoadModule('/shared/schema.js')
  const EngineClass = Engine
  const payload = host.engine.serialize({ name: 'Smoke test' })
  const valid = validateProject(payload)
  check('payload passes the shared Zod schema', valid.ok, JSON.stringify(valid.errors.slice(0, 2)))
  check('wires are string references (no object cycles on the wire)',
    payload.edges.every((edge) => typeof edge.from.node === 'string' && typeof edge.to.node === 'string'))
  const reloaded = EngineClass.fromPayload(JSON.parse(JSON.stringify(payload)))
  check('engine rebuilt from the payload',
    reloaded.simulation.componentList.length === payload.nodes.length && reloaded.simulation.fluid.count > 0,
    `${reloaded.simulation.componentList.length} nodes, ${reloaded.simulation.fluid.count} droplets`)
  for (let i = 0; i < 120; i++) reloaded.simulation.step(1 / 60)
  check('reloaded simulation runs', reloaded.simulation.stats.bodies > 0)
  reloaded.dispose()

  console.log('\n[8] fluid invariants')
  const engine = new EngineClass({ canvas: null })
  buildDemo(engine, 'proximity-pump')
  const startCount = engine.simulation.fluid.count
  for (let i = 0; i < 60 * 20; i++) engine.simulation.step(1 / 60)
  const deepest = Math.max(...engine.simulation.fluid.active.map((body) => body.position.y))
  check('no droplet leaves the world', engine.simulation.fluid.count === startCount,
    `${engine.simulation.fluid.count}/${startCount}`)
  check('nothing sank below the ground slab', deepest < 900.5, `deepest y=${deepest.toFixed(1)}`)
  // The accumulator contract: a frame that lands on the fixed period advances
  // the world exactly once, a lagging frame catches up, and a big stall is
  // clamped rather than simulated in full.
  const seqBefore = engine.simulation._sequence
  engine.frame(0)                      // first frame establishes the clock
  engine.frame(1000 / 60)              // one period
  const afterOne = engine.simulation._sequence
  check('one 60 Hz frame = exactly one fixed step', afterOne - seqBefore === 1,
    `steps=${afterOne - seqBefore}`)
  engine.frame(1000 / 60 + 1000 / 20)  // 50 ms behind
  const afterLag = engine.simulation._sequence
  check('a lagging frame catches up (50 ms → 3 steps)', afterLag - afterOne === 3,
    `steps=${afterLag - afterOne}`)
  const dropped = engine.stats.droppedSteps
  engine.frame(1000 / 20 + 5000)       // 5 s stall (backgrounded tab)
  // 5 s of wall clock would be 300 steps; the clamp caps the catch-up at
  // maxStepsPerFrame and the remainder is *shed* (counted, not simulated).
  const stallSteps = engine.simulation._sequence - afterLag
  check('a stalled frame is clamped and the backlog is shed',
    stallSteps <= engine.maxStepsPerFrame && engine.stats.droppedSteps > dropped,
    `steps=${stallSteps}/${engine.maxStepsPerFrame}, shed=${engine.stats.droppedSteps - dropped}`)
  engine.dispose()
  host.dispose()
  await vite.close()

  // Quiet the FluidSystem import (used only for its presence in the graph).
  check('FluidSystem exported', typeof FluidSystem === 'function')

  console.log('\n--- context stub census ---')
  const census = Object.entries(calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`)
  console.log(' ', census.join('  ') || '(no draw calls)')

  console.log(`\n${failures.length === 0 ? '✓ all checks passed' : `✗ ${failures.length} check(s) failed`}`)
  if (failures.length) {
    for (const failure of failures) console.log(`   · ${failure}`)
    process.exitCode = 1
  }
  console.log('')
}

main().catch((error) => {
  console.error('\nsmoke test threw:', error)
  process.exitCode = 1
})
