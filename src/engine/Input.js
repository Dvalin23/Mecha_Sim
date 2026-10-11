import { Vec2 } from './math/Vec2.js'
import { hitTestPort } from './draw/ports.js'

/**
 * Pointer + keyboard interaction layer.
 *
 * Everything the user can do is one of five gestures, resolved in this order:
 *
 *   1. **wire**    — press on a port glyph, drag, release on another port
 *   2. **actuate** — press a switch / button / dial (it handles the event itself)
 *   3. **grab**    — press a *dynamic* body: a soft spring drags it under the
 *                    cursor (a real force, so it can push other things)
 *   4. **move**    — press a component panel/fixture: the component follows the
 *                    pointer (editor gesture, no physics involvement)
 *   5. **pan**     — press empty space (or hold space/right button): move camera
 *
 * Trackpads and touch are treated identically to a mouse: only primary-button
 * drags move things, everything else pans.
 */
export class InputController {
  constructor({ canvas, engine }) {
    this.canvas = canvas
    this.engine = engine
    this.camera = engine.camera
    this.pointer = {
      screenX: 0,
      screenY: 0,
      down: false,
      button: 0,
      inside: false,
    }
    this.keys = new Set()
    this.interaction = {
      mode: 'idle',
      dragBody: null,
      dragComponent: null,
      dragOffset: new Vec2(0, 0),
      grabLocal: new Vec2(0, 0),
      pendingWire: null,
      hoveredPort: null,
      hoveredComponent: null,
      hoveredWireId: null,
      marquee: null,
      pointerWorld: new Vec2(0, 0),
      lastPanScreen: { x: 0, y: 0 },
      moved: false,
    }
    this._bound = {}
    this._touched = new Set()
  }

  attach() {
    const canvas = this.canvas
    const b = this._bound
    b.pointerdown = (e) => this.onPointerDown(e)
    b.pointermove = (e) => this.onPointerMove(e)
    b.pointerup = (e) => this.onPointerUp(e)
    b.pointerleave = (e) => this.onPointerLeave(e)
    b.wheel = (e) => this.onWheel(e)
    b.contextmenu = (e) => e.preventDefault()
    b.keydown = (e) => this.onKeyDown(e)
    b.keyup = (e) => this.onKeyUp(e)
    b.blur = () => this.keys.clear()

    canvas.addEventListener('pointerdown', b.pointerdown)
    canvas.addEventListener('pointermove', b.pointermove)
    window.addEventListener('pointerup', b.pointerup)
    canvas.addEventListener('pointerleave', b.pointerleave)
    canvas.addEventListener('wheel', b.wheel, { passive: false })
    canvas.addEventListener('contextmenu', b.contextmenu)
    window.addEventListener('keydown', b.keydown)
    window.addEventListener('keyup', b.keyup)
    window.addEventListener('blur', b.blur)
    return this
  }

  detach() {
    const canvas = this.canvas
    const b = this._bound
    canvas.removeEventListener('pointerdown', b.pointerdown)
    canvas.removeEventListener('pointermove', b.pointermove)
    window.removeEventListener('pointerup', b.pointerup)
    canvas.removeEventListener('pointerleave', b.pointerleave)
    canvas.removeEventListener('wheel', b.wheel)
    canvas.removeEventListener('contextmenu', b.contextmenu)
    window.removeEventListener('keydown', b.keydown)
    window.removeEventListener('keyup', b.keyup)
    window.removeEventListener('blur', b.blur)
    return this
  }

  // --- coordinate helpers -------------------------------------------------
  screenPoint(event) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  worldPoint(event) {
    const { x, y } = this.screenPoint(event)
    return this.camera.screenToWorld(x, y)
  }

  /** Port tolerance grows as you zoom out so ports stay clickable. */
  get portTolerance() {
    return Math.max(9, 14 / this.camera.zoom)
  }

  findPort(worldPoint) {
    let best = null
    let bestDistance = this.portTolerance
    for (const component of this.engine.simulation.componentList) {
      const port = hitTestPort(component, worldPoint, this.portTolerance)
      if (!port) continue
      const distance = port.position.distanceTo(worldPoint)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = { componentId: component.id, port: port.id, side: port.side, kind: port.kind, position: port.position }
      }
    }
    return best
  }

  /** Sample the wire Béziers to find one under the cursor. */
  findWire(worldPoint) {
    const tolerance = Math.max(6, 10 / this.camera.zoom)
    for (const edge of this.engine.simulation.edges) {
      const source = this.engine.simulation.get(edge.from.node)
      const target = this.engine.simulation.get(edge.to.node)
      if (!source || !target) continue
      const layoutA = this.engine.renderer.portLayout(source)
      const layoutB = this.engine.renderer.portLayout(target)
      const from = layoutA.outputs.find((p) => p.id === edge.from.port)?.position
      const to = layoutB.inputs.find((p) => p.id === edge.to.port)?.position
      if (!from || !to) continue
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const point = cubicPoint(from, to, t)
        if (Math.hypot(point.x - worldPoint.x, point.y - worldPoint.y) <= tolerance) return edge.id
      }
    }
    return null
  }

  // --- pointer events -----------------------------------------------------
  onPointerDown(event) {
    const world = this.worldPoint(event)
    const screen = this.screenPoint(event)
    this.pointer.down = true
    this.pointer.button = event.button
    this.pointer.screenX = screen.x
    this.pointer.screenY = screen.y
    this.interaction.pointerWorld.set(world.x, world.y)
    this.interaction.moved = false
    this.interaction.lastPanScreen = { x: screen.x, y: screen.y }
    this.canvas.setPointerCapture?.(event.pointerId)

    const forcePan = this.keys.has(' ') || event.button === 1 || event.button === 2
    const simulation = this.engine.simulation
    const engine = this.engine

    // Alt-click or right-click on a wire disconnects it.
    const wireHit = forcePan ? null : this.findWire(world)

    if (forcePan || wireHit) {
      if (wireHit) {
        simulation.disconnect(wireHit)
        engine.emit('wires:changed', { removed: wireHit })
        return
      }
      this.interaction.mode = 'pan'
      return
    }

    // 1) Ports → start a wire.
    const port = this.findPort(world)
    if (port) {
      this.interaction.mode = 'wire'
      this.interaction.pendingWire = {
        fromComponentId: port.componentId,
        fromPortId: port.port,
        side: port.side,
        kind: port.kind,
        from: port.position.clone(),
        to: new Vec2(world.x, world.y),
        valid: null,
      }
      return
    }

    // 2) Component under the cursor.
    const component = simulation.pick(world.x, world.y)

    // 2a) Self-actuating parts (switches, buttons, dials).
    if (component && typeof component.onPointerDown === 'function') {
      if (component.onPointerDown(world.x, world.y) === true) {
        this.interaction.mode = 'actuate'
        engine.select(component)
        return
      }
    }

    // 3) Dynamic body → physical grab (a spring, not a teleport).
    for (const body of simulation.world.bodies) {
      if (!body.enabled || body.removed || !body.isDynamic) continue
      if (body.userData?.componentId && simulation.get(body.userData.componentId) !== component) continue
      if (!body.containsPoint(world)) continue
      this.interaction.mode = 'grab'
      this.interaction.dragBody = body
      this.interaction.grabLocal = body.localPoint(world)
      engine.select(component ?? simulation.componentOfBody(body))
      body.wake()
      return
    }

    // 4) Move a component (fixtures and panels).
    if (component) {
      this.interaction.mode = 'move'
      this.interaction.dragComponent = component
      this.interaction.dragOffset.set(world.x - component.position.x, world.y - component.position.y)
      engine.select(component)
      return
    }

    // 5) Empty space → deselect + pan.
    engine.select(null)
    this.interaction.mode = 'pan'
  }

  onPointerMove(event) {
    const world = this.worldPoint(event)
    const screen = this.screenPoint(event)
    const interaction = this.interaction
    const movedX = screen.x - this.pointer.screenX
    const movedY = screen.y - this.pointer.screenY
    if (Math.abs(movedX) > 2 || Math.abs(movedY) > 2) interaction.moved = true
    this.pointer.screenX = screen.x
    this.pointer.screenY = screen.y
    this.pointer.inside = true
    interaction.pointerWorld.set(world.x, world.y)

    // Hover feedback (cheap enough to run every move).
    interaction.hoveredPort = this.pointer.down ? interaction.hoveredPort : this.findPort(world)
    const hoveredComponent = this.engine.simulation.pick(world.x, world.y)
    if (interaction.hoveredComponent !== hoveredComponent) {
      if (interaction.hoveredComponent) interaction.hoveredComponent.hovered = false
      if (hoveredComponent) hoveredComponent.hovered = true
      interaction.hoveredComponent = hoveredComponent
      if (hoveredComponent) this.engine.renderer.invalidatePorts()
    }

    switch (interaction.mode) {
      case 'pan': {
        const dx = screen.x - interaction.lastPanScreen.x
        const dy = screen.y - interaction.lastPanScreen.y
        this.camera.panByScreen(dx, dy)
        interaction.lastPanScreen = { x: screen.x, y: screen.y }
        break
      }
      case 'move': {
        const component = interaction.dragComponent
        if (component) {
          const gridSize = this.keys.has('shift') ? 1 : this.snapSize
          const x = snap(world.x - interaction.dragOffset.x, gridSize)
          const y = snap(world.y - interaction.dragOffset.y, gridSize)
          component.setPosition(x, y)
          this.engine.renderer.invalidatePorts(component.id)
        }
        break
      }
      case 'grab': {
        const body = interaction.dragBody
        if (body && !body.removed) {
          const target = body.worldPoint(interaction.grabLocal)
          // Critically damped spring: F = k·Δx − c·v, scaled by the body's mass
          // so heavy crates feel heavy but still track the cursor.
          const k = 42
          const c = 12
          const dx = world.x - target.x
          const dy = world.y - target.y
          body.applyForce(
            new Vec2((dx * k - body.velocity.x * c) * body.mass, (dy * k - body.velocity.y * c) * body.mass),
          )
          body.applyTorque(-body.angularVelocity * body.inertia * 6)
          body.wake()
        }
        break
      }
      case 'wire': {
        if (interaction.pendingWire) {
          interaction.pendingWire.to.set(world.x, world.y)
          const hovered = this.findPort(world)
          const valid = hovered && this.validateWire(interaction.pendingWire, hovered)
          interaction.pendingWire.valid = valid === null ? null : valid
          interaction.hoveredPort = hovered
        }
        break
      }
      case 'actuate': {
        const component = interaction.hoveredComponent
        if (component && typeof component.onPointerDrag === 'function') {
          component.onPointerDrag(world.x, world.y)
        }
        break
      }
      default:
        break
    }
  }

  onPointerUp(event) {
    const interaction = this.interaction
    const world = this.worldPoint(event)
    const mode = interaction.mode

    if (mode === 'wire' && interaction.pendingWire) {
      const port = this.findPort(world)
      if (port) this.completeWire(interaction.pendingWire, port)
      interaction.pendingWire = null
    }

    if (mode === 'actuate') {
      const component = interaction.hoveredComponent
      component?.onPointerUp?.(world.x, world.y)
    }

    if (mode === 'grab' && interaction.dragBody) {
      interaction.dragBody = null
    }

    if (mode === 'move' && interaction.dragComponent) {
      this.engine.emit('component:moved', interaction.dragComponent)
      interaction.dragComponent = null
    }

    interaction.mode = 'idle'
    this.pointer.down = false
    this.canvas.releasePointerCapture?.(event.pointerId)
  }

  onPointerLeave() {
    this.pointer.inside = false
    const hovered = this.interaction.hoveredComponent
    if (hovered) hovered.hovered = false
    this.interaction.hoveredComponent = null
    this.interaction.hoveredPort = null
  }

  onWheel(event) {
    event.preventDefault()
    const screen = this.screenPoint(event)
    const factor = Math.exp(-event.deltaY * 0.0013)
    this.camera.zoomAt(screen.x, screen.y, factor)
    return false
  }

  onKeyDown(event) {
    const tag = event.target?.tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable
    if (event.key === ' ') this.keys.add(' ')
    if (event.key === 'Shift') this.keys.add('shift')
    if (typing) return

    switch (event.key) {
      case ' ':
        event.preventDefault()
        this.engine.toggleRunning()
        break
      case 'Escape':
        this.interaction.pendingWire = null
        this.engine.select(null)
        break
      case 'Delete':
      case 'Backspace':
        if (this.engine.selectedComponent) {
          event.preventDefault()
          this.engine.deleteComponent(this.engine.selectedComponent.id)
        }
        break
      case 'r':
      case 'R':
        this.engine.resetScene()
        break
      case 'f':
      case 'F':
        this.engine.fitView()
        break
      case 'g':
      case 'G':
        this.engine.renderer.debug.grid = !this.engine.renderer.debug.grid
        break
      case 'h':
      case 'H':
        this.engine.renderer.debug.hash = !this.engine.renderer.debug.hash
        break
      case 'c':
      case 'C':
        this.engine.renderer.debug.contacts = !this.engine.renderer.debug.contacts
        break
      case 'a':
      case 'A':
        this.engine.renderer.debug.aabb = !this.engine.renderer.debug.aabb
        break
      case 'v':
      case 'V':
        this.engine.renderer.debug.velocity = !this.engine.renderer.debug.velocity
        break
      case 'p':
      case 'P':
        this.engine.renderer.debug.particles = !this.engine.renderer.debug.particles
        break
      case '+':
      case '=':
        this.camera.setZoom(this.camera.zoom * 1.15)
        break
      case '-':
      case '_':
        this.camera.setZoom(this.camera.zoom / 1.15)
        break
      case 'ArrowLeft':
        this.camera.panByScreen(40, 0)
        break
      case 'ArrowRight':
        this.camera.panByScreen(-40, 0)
        break
      case 'ArrowUp':
        this.camera.panByScreen(0, 40)
        break
      case 'ArrowDown':
        this.camera.panByScreen(0, -40)
        break
      default:
        break
    }
  }

  onKeyUp(event) {
    if (event.key === ' ') this.keys.delete(' ')
    if (event.key === 'Shift') this.keys.delete('shift')
  }

  get snapSize() {
    return this.keys.has('alt') ? 1 : 1
  }

  /** null = not comparable, true/false = would connect. */
  validateWire(pending, targetPort) {
    if (targetPort.componentId === pending.fromComponentId) return false
    if (pending.side === targetPort.side) return false // out→in or in→out only
    return true
  }

  completeWire(pending, targetPort) {
    if (this.validateWire(pending, targetPort) !== true) return null
    const simulation = this.engine.simulation
    const fromIsOutput = pending.side === 'out'
    const from = fromIsOutput ? pending : targetPort
    const to = fromIsOutput ? targetPort : pending
    try {
      const edge = simulation.connect(from.componentId, from.port, to.componentId, to.port)
      this.engine.emit('wires:changed', { added: edge })
      return edge
    } catch (error) {
      this.engine.emit('error', { message: error.message })
      return null
    }
  }
}

const snap = (value, size) => (size > 1 ? Math.round(value / size) * size : Math.round(value))

function cubicPoint(from, to, t) {
  const dx = Math.abs(to.x - from.x)
  const bow = Math.max(34, Math.min(dx * 0.55, 180))
  const c1 = { x: from.x + bow, y: from.y }
  const c2 = { x: to.x - bow, y: to.y }
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y,
  }
}
