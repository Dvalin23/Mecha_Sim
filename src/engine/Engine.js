import { Camera } from './Camera.js'
import { Renderer } from './Renderer.js'
import { InputController } from './Input.js'
import { Simulation, Emitter } from './Simulation.js'
import { createComponent } from './registry.js'
import { deserializeProject, restoreScene, serializeProject, serializeScene, emptyProject } from './serialization.js'
import { Vec2 } from './math/Vec2.js'
import { clamp } from './math/utils.js'

/** Physics grid: exactly 60 Hz, independent of display refresh rate. */
export const FIXED_DT = 1 / 60
/** Guard against the "spiral of death" when a frame takes far too long. */
export const MAX_STEPS_PER_FRAME = 5

/**
 * Engine — the imperative half of the app.
 *
 * Owns the **fixed-timestep accumulator**, which is what makes the simulation
 * hardware-independent:
 *
 *   frame(t):  Δt_real = t − t_prev
 *              accumulator += Δt_real · timeScale
 *              while (accumulator ≥ Δt) { simulation.step(Δt); accumulator −= Δt }
 *              α = accumulator / Δt                 ← render interpolation
 *
 * A 144 Hz monitor runs the physics exactly as often as a 60 Hz one; the extra
 * frames only get a smoother interpolated picture. React never drives this loop
 * — it only reads the stats and pushes mutations in.
 */
export class Engine extends Emitter {
  constructor(options = {}) {
    super()
    const {
      canvas,
      simulation = new Simulation(),
      camera = {},
      autoStart = false,
      maxStepsPerFrame = MAX_STEPS_PER_FRAME,
    } = options

    this.canvas = canvas
    this.ctx = canvas?.getContext('2d', { alpha: false }) ?? null
    this.simulation = simulation
    this.camera = new Camera({ x: simulation.bounds.width / 2, y: simulation.bounds.height / 2, ...camera })
    this.renderer = this.ctx
      ? new Renderer({ canvas, ctx: this.ctx, simulation, camera: this.camera })
      : null
    this.input = canvas ? new InputController({ canvas, engine: this }) : null

    this.running = true
    this.timeScale = 1
    this.maxStepsPerFrame = maxStepsPerFrame
    this._accumulator = 0
    this._lastTime = 0
    this._rafId = null
    this._frameTimes = []
    this._lastStatsEmit = 0
    this._resizeObserver = null

    this.stats = {
      fps: 60,
      frameMs: 16.7,
      physicsMs: 0,
      steps: 0,
      totalSteps: 0,
      droppedSteps: 0,
      alpha: 0,
      accumulator: 0,
      timeScale: 1,
      running: true,
      bodies: 0,
      contacts: 0,
      candidatePairs: 0,
      solverMs: 0,
      hashCells: 0,
      fluid: 0,
      components: 0,
      wires: 0,
    }

    this.selectedComponent = null
    this.history = { undo: [], redo: [], limit: 40 }
    this._suppressHistory = false

    /** Set by the React layer so DOM CustomEvents can be dispatched. */
    this._wireSubscriptions()
  }

  _wireSubscriptions() {
    this.simulation.on('component:added', () => this.commitHistory('add'))
    this.simulation.on('component:removed', () => this.commitHistory('remove'))
    this.simulation.on('wire:added', () => this.commitHistory('wire'))
    this.simulation.on('wire:removed', () => this.commitHistory('wire'))
    this.on('component:moved', () => this.commitHistory('move'))
  }

  // --- lifecycle ----------------------------------------------------------
  attach() {
    if (!this.canvas) return this
    this.input?.attach()
    this.handleResize()
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.handleResize())
      this._resizeObserver.observe(this.canvas.parentElement ?? this.canvas)
    } else {
      this._onWindowResize = () => this.handleResize()
      window.addEventListener('resize', this._onWindowResize)
    }
    return this
  }

  /**
   * @param {boolean} autoStart start the rAF loop immediately (the React shell
   *        starts it after mount; tests keep it stopped and call step()).
   */
  start(autoStart = true) {
    this.attach()
    if (!autoStart || !this.ctx) return this
    this._lastTime = performance.now() / 1000
    this._tick = (timestamp) => this.frame(timestamp)
    this._rafId = requestAnimationFrame(this._tick)
    return this
  }

  stop() {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId)
    this._rafId = null
    return this
  }

  dispose() {
    this.stop()
    this.input?.detach()
    this._resizeObserver?.disconnect()
    if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize)
    this.simulation.world.clear()
    this.simulation.components.clear()
    this.simulation.edges = []
    if (this.canvas) {
      const ctx = this.ctx
      ctx?.setTransform(1, 0, 0, 1, 0, 0)
      ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
    this.clear()
    return this
  }

  handleResize() {
    if (!this.renderer || !this.canvas) return
    const parent = this.canvas.parentElement ?? this.canvas
    const rect = parent.getBoundingClientRect()
    const width = Math.max(Math.floor(rect.width), 320)
    const height = Math.max(Math.floor(rect.height), 240)
    this.renderer.resize(width, height, window.devicePixelRatio || 1)
    return this
  }

  // --- the loop -----------------------------------------------------------
  frame(timestampMs) {
    const nowSeconds = timestampMs / 1000
    let frameTime = nowSeconds - this._lastTime
    this._lastTime = nowSeconds
    // A backgrounded tab returns with a huge Δt: clamp instead of simulating a
    // hundred steps and blowing up the world.
    if (!Number.isFinite(frameTime) || frameTime < 0) frameTime = FIXED_DT
    frameTime = Math.min(frameTime, 0.25)

    const t0 = performance.now()
    let steps = 0
    if (this.running) {
      this._accumulator += frameTime * this.timeScale
      const dt = this.simulation.timestep
      while (this._accumulator >= dt && steps < this.maxStepsPerFrame) {
        this.simulation.step(dt)
        this._accumulator -= dt
        steps++
      }
      if (steps >= this.maxStepsPerFrame && this._accumulator >= dt) {
        // Shed the backlog: better a slow sim than an unbounded one.
        this.stats.droppedSteps += Math.floor(this._accumulator / dt)
        this._accumulator = 0
      }
    }
    const physicsMs = performance.now() - t0

    const alpha = this.running ? clamp(this._accumulator / this.simulation.timestep, 0, 1) : 0
    const t1 = performance.now()
    this.renderer?.render(alpha, this.input?.interaction ?? null)
    const renderMs = performance.now() - t1

    // Rolling FPS over the last second of frames.
    this._frameTimes.push(nowSeconds)
    while (this._frameTimes.length && nowSeconds - this._frameTimes[0] > 1) this._frameTimes.shift()
    const sim = this.simulation.stats

    Object.assign(this.stats, {
      fps: Math.round(this._frameTimes.length),
      frameMs: round(frameTime * 1000, 2),
      physicsMs: round(physicsMs, 2),
      renderMs: round(renderMs, 2),
      steps: steps,
      alpha: round(alpha, 3),
      accumulator: round(this._accumulator, 4),
      timeScale: this.timeScale,
      running: this.running,
      bodies: sim.bodies,
      contacts: sim.contacts,
      candidatePairs: sim.candidatePairs,
      solverMs: round(sim.solverMs, 2),
      hashCells: sim.hashCells,
      maxOccupancy: sim.maxOccupancy,
      fluid: sim.fluid,
      components: sim.components,
      wires: sim.wires,
      arbiters: sim.arbiters,
      simTime: round(this.simulation.world.time, 2),
    })
    this.stats.totalSteps += steps

    // Throttled push to React (4 Hz) — the HUD does not need 60 Hz updates and
    // re-rendering the panel every frame would defeat the whole point.
    if (nowSeconds - this._lastStatsEmit > 0.25) {
      this._lastStatsEmit = nowSeconds
      this.emit('stats', this.stats)
    }

    this._rafId = requestAnimationFrame(this._tick)
  }

  /** Advance exactly one fixed step while paused (frame-by-frame debugging). */
  stepOnce() {
    this.simulation.step(this.simulation.timestep)
    this.renderer?.render(1, this.input?.interaction ?? null)
    this.emit('stats', this.stats)
    return this
  }

  setRunning(running) {
    this.running = !!running
    this.stats.running = this.running
    this.emit('running:changed', this.running)
    return this
  }

  toggleRunning() {
    return this.setRunning(!this.running)
  }

  setTimeScale(scale) {
    this.timeScale = clamp(scale, 0.05, 4)
    return this
  }

  fitView(padding = 90) {
    const bounds = this.contentBounds()
    this.camera.fit(bounds, padding)
    return this
  }

  /** World bounds of everything placed in the scene (used by "fit view"). */
  contentBounds() {
    const world = this.simulation.world
    let minX = 0
    let minY = 0
    let maxX = this.simulation.bounds.width
    let maxY = this.simulation.bounds.height
    for (const body of world.bodies) {
      if (body.removed) continue
      minX = Math.min(minX, body.aabb.minX)
      minY = Math.min(minY, body.aabb.minY)
      maxX = Math.max(maxX, body.aabb.maxX)
      maxY = Math.max(maxY, body.aabb.maxY)
    }
    return { minX, minY, maxX, maxY }
  }

  // --- selection (the React <-> engine bridge) ----------------------------
  /**
   * Select a component and notify the React shell through a **CustomEvent on
   * the canvas element** — the vanilla engine never imports React, and React
   * never reaches into engine internals to find out what is selected.
   */
  select(componentOrId) {
    const component =
      typeof componentOrId === 'string'
        ? this.simulation.get(componentOrId)
        : componentOrId ?? null
    if (this.selectedComponent === component) return component
    if (this.selectedComponent) this.selectedComponent.selected = false
    this.selectedComponent = component
    if (component) component.selected = true
    this.renderer?.invalidatePorts()

    if (this.canvas) {
      this.canvas.dispatchEvent(
        new CustomEvent('entitySelected', {
          detail: {
            entityId: component?.id ?? null,
            type: component?.type ?? null,
            position: component ? { x: component.position.x, y: component.position.y } : null,
          },
        }),
      )
    }
    this.emit('selection:changed', component)
    return component
  }

  // --- scene editing ------------------------------------------------------
  addComponent(type, position = { x: 400, y: 300 }, options = {}) {
    const { rotation = 0, ...properties } = options
    const component = createComponent(type, {
      position: new Vec2(position.x, position.y),
      rotation,
      properties,
    })
    this.simulation.add(component)
    this.renderer?.invalidatePorts()
    this.select(component)
    return component
  }

  deleteComponent(id) {
    const component = this.simulation.get(id)
    if (!component) return false
    if (this.selectedComponent === component) this.select(null)
    const removed = this.simulation.remove(component)
    this.renderer?.invalidatePorts()
    return removed
  }

  duplicateComponent(id, offset = 40) {
    const component = this.simulation.get(id)
    if (!component) return null
    const snapshot = component.serialize()
    const clone = createComponent(snapshot.type, {
      position: new Vec2(snapshot.x + offset, snapshot.y + offset),
      rotation: snapshot.rotation,
      properties: snapshot.properties,
    })
    this.simulation.add(clone)
    this.select(clone)
    return clone
  }

  updateProperty(componentOrId, key, value) {
    const component =
      typeof componentOrId === 'string' ? this.simulation.get(componentOrId) : componentOrId
    if (!component) return false
    component.onPropertyChanged(key, value)
    if (component.type === 'Controller' && key === 'rules') component.setRules(value)
    this.renderer?.invalidatePorts(component.id)
    this.emit('component:changed', { component, key, value })
    return true
  }

  /** Reset every component's runtime state without touching the scene graph. */
  resetScene() {
    const scene = serializeScene(this.simulation)
    const previousSelection = this.selectedComponent?.id ?? null
    for (const component of this.simulation.componentList) component.dispose()
    this.simulation.components.clear()
    this.simulation.edges = []
    this.simulation.world.clear()
    this.simulation.fluid.clear()
    this.simulation.world.arbiters.clear()
    this.simulation.traces.clear()
    this._suppressHistory = true
    restoreScene(this.simulation, scene, { silent: true })
    this.simulation._sequence = 0
    this._suppressHistory = false
    this._accumulator = 0
    this.renderer?.invalidatePorts()
    this.select(previousSelection)
    this.emit('scene:reset')
    return this
  }

  // --- persistence --------------------------------------------------------
  serialize(meta = {}) {
    return serializeProject(this.simulation, meta)
  }

  /** Replace the running scene with a stored payload. */
  load(payload, options = {}) {
    const selected = this.selectedComponent?.id ?? null
    for (const component of this.simulation.componentList) component.dispose()
    this.simulation.components.clear()
    this.simulation.edges = []
    this.simulation.world.clear()
    this.simulation.fluid.clear()
    this.simulation.traces.clear()
    this.history.undo.length = 0
    this.history.redo.length = 0

    const env = payload?.environment ?? {}
    this.simulation.id = payload?.simulationId ?? this.simulation.id
    this.simulation.name = payload?.name ?? this.simulation.name
    this.simulation.setGravity(env.gravity ?? 981)
    this.simulation.timestep = env.timestep ?? FIXED_DT
    this.simulation.world.fixedDt = this.simulation.timestep
    if (env.bounds) this.simulation.bounds = { minX: 0, minY: 0, ...env.bounds, ...(payload.bounds ?? {}) }

    this._suppressHistory = true
    const upgradedScene = options.upgraded ?? payload
    restoreScene(this.simulation, upgradedScene, { silent: true })
    if (payload?.fluid?.particles?.length) this.simulation.fluid.deserialize(payload.fluid)
    this._suppressHistory = false

    this.renderer?.invalidatePorts()
    this._accumulator = 0
    this.select(selected && this.simulation.get(selected) ? selected : null)
    this.fitView()
    this.emit('scene:loaded', { id: this.simulation.id })
    return this
  }

  // --- undo / redo --------------------------------------------------------
  /** Snapshot the structural scene onto the undo stack. */
  /**
   * Push the **current** scene onto the undo stack.
   *
   * The engine's mutation events fire *after* the mutation (a component is
   * removed, then `component:removed` is emitted), so the top of the stack is
   * always the state you are looking at. Undo therefore means "discard the top
   * and restore the one underneath", which is what `undo()` below does. The
   * previous arrangement (push-after-change, undo = pop-and-apply) made the
   * first undo re-apply the state it was already in — a visible no-op — and it
   * took two undos to actually go back.
   */
  commitHistory(label = 'edit') {
    if (this._suppressHistory) return
    const snapshot = { label, scene: serializeScene(this.simulation), selection: this.selectedComponent?.id ?? null }
    const stack = this.history.undo
    const previous = stack[stack.length - 1]
    if (previous && sameScene(previous.scene, snapshot.scene)) return
    stack.push(snapshot)
    if (stack.length > this.history.limit) stack.shift()
    this.history.redo.length = 0
    this.emit('history:changed', { undo: stack.length, redo: this.history.redo.length })
  }

  _applySnapshot(snapshot) {
    const previousSelection = snapshot.selection ?? null
    for (const component of this.simulation.componentList) component.dispose()
    this.simulation.components.clear()
    this.simulation.edges = []
    this.simulation.world.clear()
    this.simulation.fluid.clear()
    this._suppressHistory = true
    restoreScene(this.simulation, snapshot.scene, { silent: true })
    this._suppressHistory = false
    this.renderer?.invalidatePorts()
    this.select(previousSelection && this.simulation.get(previousSelection) ? previousSelection : null)
  }

  undo() {
    const stack = this.history.undo
    // Two entries are needed: the top *is* the current state.
    if (stack.length < 2) return false
    this.history.redo.push(stack.pop())
    this._applySnapshot(stack[stack.length - 1])
    this.emit('history:changed', { undo: stack.length, redo: this.history.redo.length })
    return true
  }

  redo() {
    const snapshot = this.history.redo.pop()
    if (!snapshot) return false
    this.history.undo.push(snapshot)
    this._applySnapshot(snapshot)
    this.emit('history:changed', { undo: this.history.undo.length, redo: this.history.redo.length })
    return true
  }

  // --- convenience --------------------------------------------------------
  newScene(name = 'Untitled Simulation') {
    const payload = emptyProject(name)
    this.load(payload)
    return this
  }

  /**
   * Build an `Engine` directly from a stored payload.
   *
   * The static used to return the `Simulation` built by `deserializeProject`,
   * which made `Engine.fromPayload(...)` name a `Simulation` — a trap for the
   * loading path in the UI. Pass `canvas: null` (the default) for headless use.
   */
  static fromPayload(payload, options = {}) {
    const simulation = deserializeProject(payload, options)
    const engine = new Engine({ canvas: options.canvas ?? null, simulation, autoStart: false, ...options })
    engine.fitView()
    return engine
  }

  get componentCount() {
    return this.simulation.components.size
  }
}

/** Cheap structural equality for two serialized scenes (used to dedupe history). */
const sameScene = (a, b) => {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const round = (value, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export { Simulation, serializeProject, deserializeProject }
