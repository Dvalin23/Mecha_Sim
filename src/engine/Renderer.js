import { Vec2 } from './math/Vec2.js'
import { lampColors } from './draw/palette.js'

/**
 * Canvas renderer.
 *
 * Responsibilities:
 *   * device-pixel-ratio aware sizing (crisp on HiDPI, capped for perf),
 *   * the camera transform,
 *   * render *interpolation* so the picture is smooth even though physics runs
 *     on a fixed 60 Hz grid (`alpha` blends prev → current transform),
 *   * drawing all rigid bodies, wires, port glyphs, overlays and the debug views.
 *
 * The renderer never mutates simulation state.
 */
export class Renderer {
  constructor({ canvas, ctx, simulation, camera }) {
    this.canvas = canvas
    this.ctx = ctx
    this.simulation = simulation
    this.camera = camera
    this.dpr = 1
    this.width = 0
    this.height = 0
    this.debug = {
      grid: true,
      hash: false,
      aabb: false,
      contacts: false,
      velocity: false,
      particles: true,
      ui: true,
    }
    this.theme = {
      background: '#070b14',
      gridMinor: 'rgba(56,110,180,0.10)',
      gridMajor: 'rgba(56,140,220,0.20)',
      bounds: 'rgba(56,189,248,0.35)',
      staticBody: '#26303f',
      staticStroke: '#94a3b8',
      wire: '#334f7a',
      wireActive: '#4ade80',
      selection: '#38bdf8',
      hover: 'rgba(56,189,248,0.5)',
      water: '#38bdf8',
    }
    this._portLayoutCache = new Map()
  }

  resize(cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
    this.dpr = Math.min(dpr, 2)
    this.width = cssWidth
    this.height = cssHeight
    this.canvas.width = Math.floor(cssWidth * this.dpr)
    this.canvas.height = Math.floor(cssHeight * this.dpr)
    this.canvas.style.width = `${cssWidth}px`
    this.canvas.style.height = `${cssHeight}px`
    this.camera.setViewport(cssWidth, cssHeight)
    return this
  }

  /** Port geometry is cached per component and invalidated by a token. */
  portLayout(component) {
    const token = `${Math.round(component.position.x)},${Math.round(component.position.y)},${component.rotation.toFixed(3)},${component.bodies.length}`
    const cached = this._portLayoutCache.get(component.id)
    if (cached && cached.token === token) return cached.layout
    const layout = portLayoutOf(component)
    this._portLayoutCache.set(component.id, { token, layout })
    return layout
  }

  invalidatePorts(componentId) {
    if (componentId) this._portLayoutCache.delete(componentId)
    else this._portLayoutCache.clear()
  }

  render(alpha = 1, interaction = null) {
    const ctx = this.ctx
    const camera = this.camera
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = this.theme.background
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.save()
    camera.apply(ctx)

    const visible = camera.visibleBounds
    if (this.debug.grid) this.drawGrid(visible)
    this.drawWorldBounds()
    if (this.debug.hash) this.drawSpatialHash(visible)

    // 1) Physics geometry: fluid first (behind), then orphan bodies.
    if (this.debug.particles) this.drawFluid(alpha)
    this.drawOrphanBodies(alpha)

    // 2) Wires sit above the static layer, below the components they connect.
    this.drawWires(interaction)

    // 3) Mechatronic components (each draws its own bodies).
    for (const component of this.simulation.componentList) {
      ctx.save()
      component.draw(ctx, { alpha, camera, renderer: this })
      ctx.restore()
    }

    // 4) Debug views.
    if (this.debug.contacts) this.drawContacts()
    if (this.debug.aabb) this.drawAABBs()
    if (this.debug.velocity) this.drawVelocities()

    // 5) Selection + ports.
    this.drawSelection(interaction)

    // 6) Overlays (LCD text, lamps) render last so nothing occludes them.
    for (const component of this.simulation.componentList) {
      ctx.save()
      component.drawOverlay(ctx, { alpha, camera, renderer: this })
      ctx.restore()
    }

    if (interaction?.pendingWire) this.drawPendingWire(interaction.pendingWire)
    if (interaction?.marquee) this.drawMarquee(interaction.marquee)

    ctx.restore()
  }

  // --- layers -------------------------------------------------------------
  drawGrid(visible) {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    let minor = 50
    // Reduce grid density when zoomed far out so it never turns into mush.
    while (minor * zoom < 12) minor *= 5
    const major = minor * 4

    ctx.save()
    ctx.lineWidth = 1 / zoom
    const startX = Math.floor(visible.minX / minor) * minor
    const startY = Math.floor(visible.minY / minor) * minor

    ctx.beginPath()
    for (let x = startX; x <= visible.maxX; x += minor) {
      ctx.moveTo(x, visible.minY)
      ctx.lineTo(x, visible.maxY)
    }
    for (let y = startY; y <= visible.maxY; y += minor) {
      ctx.moveTo(visible.minX, y)
      ctx.lineTo(visible.maxX, y)
    }
    ctx.strokeStyle = this.theme.gridMinor
    ctx.stroke()

    ctx.beginPath()
    const startMajorX = Math.floor(visible.minX / major) * major
    const startMajorY = Math.floor(visible.minY / major) * major
    for (let x = startMajorX; x <= visible.maxX; x += major) {
      ctx.moveTo(x, visible.minY)
      ctx.lineTo(x, visible.maxY)
    }
    for (let y = startMajorY; y <= visible.maxY; y += major) {
      ctx.moveTo(visible.minX, y)
      ctx.lineTo(visible.maxX, y)
    }
    ctx.strokeStyle = this.theme.gridMajor
    ctx.lineWidth = 1 / zoom
    ctx.stroke()

    // Scale legend: one major cell = 2 m.
    ctx.fillStyle = 'rgba(148,197,255,0.4)'
    ctx.font = `${11 / zoom}px "JetBrains Mono", ui-monospace, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(`${(major / 100).toFixed(0)} m`, visible.minX + 8 / zoom, visible.minY + 6 / zoom)
    ctx.restore()
  }

  drawWorldBounds() {
    const { width, height } = this.simulation.bounds
    const ctx = this.ctx
    const zoom = this.camera.zoom
    ctx.save()
    ctx.strokeStyle = this.theme.bounds
    ctx.lineWidth = 2 / zoom
    ctx.setLineDash([14 / zoom, 10 / zoom])
    ctx.strokeRect(0, 0, width, height)
    ctx.restore()
  }

  drawSpatialHash(visible) {
    const ctx = this.ctx
    const hash = this.simulation.world.spatialHash
    const size = hash.cellSize
    const zoom = this.camera.zoom
    ctx.save()
    ctx.lineWidth = 1 / zoom
    ctx.strokeStyle = 'rgba(129,140,248,0.18)'
    ctx.beginPath()
    const minX = Math.floor(visible.minX / size) * size
    const minY = Math.floor(visible.minY / size) * size
    for (let x = minX; x <= visible.maxX; x += size) {
      ctx.moveTo(x, visible.minY)
      ctx.lineTo(x, visible.maxY)
    }
    for (let y = minY; y <= visible.maxY; y += size) {
      ctx.moveTo(visible.minX, y)
      ctx.lineTo(visible.maxX, y)
    }
    ctx.stroke()

    // Highlight occupied cells.
    ctx.fillStyle = 'rgba(129,140,248,0.10)'
    for (const [key, bucket] of hash.cells) {
      if (key === hash.constructor.key(-1, -1)) continue
      const cx = (key >> 16) - 32768
      const cy = (key & 0xffff) - 32768
      const x = cx * size
      const y = cy * size
      if (x > visible.maxX || y > visible.maxY || x + size < visible.minX || y + size < visible.minY) continue
      ctx.globalAlpha = Math.min(0.06 + bucket.length * 0.05, 0.45)
      ctx.fillRect(x, y, size, size)
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }

  /** Interpolated transform of a body between two fixed steps. */
  bodyTransform(body, alpha) {
    if (alpha >= 1 || body.isStatic) return { x: body.position.x, y: body.position.y, angle: body.angle }
    return {
      x: body.prevPosition.x + (body.position.x - body.prevPosition.x) * alpha,
      y: body.prevPosition.y + (body.position.y - body.prevPosition.y) * alpha,
      angle: body.prevAngle + (body.angle - body.prevAngle) * alpha,
    }
  }

  drawFluid(alpha) {
    const ctx = this.ctx
    const particles = this.simulation.fluid.active
    if (!particles.length) return
    ctx.save()
    for (const body of particles) {
      if (!body.enabled || body.removed) continue
      const t = this.bodyTransform(body, alpha)
      const speed = body.velocity.length()
      const radius = body.shape.radius
      ctx.beginPath()
      ctx.arc(t.x, t.y, radius, 0, Math.PI * 2)
      // Fast droplets glow: visual speedometer for the pump's draft.
      ctx.fillStyle =
        speed > 220 ? 'rgba(125,211,252,0.95)' : speed > 90 ? 'rgba(56,189,248,0.9)' : 'rgba(37,99,235,0.85)'
      ctx.fill()
    }
    ctx.restore()
  }

  drawOrphanBodies(alpha) {
    const ctx = this.ctx
    for (const body of this.simulation.world.bodies) {
      if (body.removed || !body.enabled) continue
      if (body.userData?.componentId || body.isFluid) continue
      const t = this.bodyTransform(body, alpha)
      ctx.save()
      ctx.translate(t.x, t.y)
      ctx.rotate(t.angle)
      if (body.shape.type === 'circle') {
        ctx.beginPath()
        ctx.arc(0, 0, body.shape.radius, 0, Math.PI * 2)
        ctx.fillStyle = '#1f2a3a'
        ctx.fill()
        ctx.strokeStyle = this.theme.staticStroke
        ctx.lineWidth = 1.4
        ctx.stroke()
      } else {
        ctx.beginPath()
        for (let i = 0; i < body.shape.vertices.length; i++) {
          const v = body.shape.vertices[i]
          if (i === 0) ctx.moveTo(v.x, v.y)
          else ctx.lineTo(v.x, v.y)
        }
        ctx.closePath()
        ctx.fillStyle = this.theme.staticBody
        ctx.fill()
        ctx.strokeStyle = this.theme.staticStroke
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  drawWires(interaction) {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    const time = performance.now() / 1000
    for (const edge of this.simulation.edges) {
      const source = this.simulation.get(edge.from.node)
      const target = this.simulation.get(edge.to.node)
      if (!source || !target) continue
      const from = this.portLayout(source).outputs.find((p) => p.id === edge.from.port)?.position
      const to = this.portLayout(target).inputs.find((p) => p.id === edge.to.port)?.position
      if (!from || !to) continue

      const value = source.outputValues[edge.from.port]
      const active = edge.kind === 'digital' ? value === true : Math.abs(Number(value) || 0) > 0.001
      const hovered = interaction?.hoveredWireId === edge.id

      const { c1, c2 } = wirePathOf(from, to)
      ctx.save()
      ctx.lineCap = 'round'
      // Outer glow for live signals.
      if (active) {
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
        ctx.strokeStyle = 'rgba(74,222,128,0.18)'
        ctx.lineWidth = 7 / zoom
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
      ctx.strokeStyle = hovered ? '#f87171' : active ? this.theme.wireActive : this.theme.wire
      ctx.lineWidth = (hovered ? 3.2 : active ? 2.6 : 1.8) / Math.max(zoom, 0.4)
      ctx.stroke()
      ctx.restore()

      // Travelling pulse along an energised wire.
      if (active && edge.kind !== 'text') {
        const t = (time * 0.7) % 1
        const point = bezierPoint(from, c1, c2, to, t)
        ctx.beginPath()
        ctx.arc(point.x, point.y, 3 / Math.max(zoom, 0.4), 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(190,255,210,0.95)'
        ctx.fill()
      }
    }
  }

  drawPendingWire(pending) {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    const from = pending.from
    const to = pending.to
    const { c1, c2 } = wirePathOf(from, to)
    ctx.save()
    ctx.setLineDash([10 / zoom, 8 / zoom])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
    ctx.strokeStyle = pending.valid === false ? '#f87171' : '#7dd3fc'
    ctx.lineWidth = 2.2 / Math.max(zoom, 0.4)
    ctx.stroke()
    ctx.restore()
  }

  drawMarquee(marquee) {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    ctx.save()
    ctx.strokeStyle = 'rgba(56,189,248,0.8)'
    ctx.fillStyle = 'rgba(56,189,248,0.10)'
    ctx.lineWidth = 1 / zoom
    ctx.setLineDash([6 / zoom, 4 / zoom])
    ctx.beginPath()
    ctx.rect(marquee.minX, marquee.minY, marquee.maxX - marquee.minX, marquee.maxY - marquee.minY)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  drawSelection(interaction) {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    for (const component of this.simulation.componentList) {
      const selected = component.selected
      const hovered = component.hovered
      if (!selected && !hovered) continue
      const bounds = component.getBounds()
      ctx.save()
      ctx.strokeStyle = selected ? this.theme.selection : this.theme.hover
      ctx.lineWidth = (selected ? 2.2 : 1.4) / Math.max(zoom, 0.3)
      ctx.setLineDash(selected ? [] : [8 / zoom, 6 / zoom])
      ctx.strokeRect(bounds.minX - 6, bounds.minY - 6, bounds.maxX - bounds.minX + 12, bounds.maxY - bounds.minY + 12)
      ctx.restore()

      if (selected) this.drawPortGlyphs(component, interaction)
    }
  }

  drawPortGlyphs(component, interaction) {
    const ctx = this.ctx
    const layout = this.portLayout(component)
    const hovering = interaction?.hoveredPort
    for (const port of [...layout.inputs, ...layout.outputs]) {
      const value =
        port.side === 'in' ? component.inputValues[port.id] : component.outputValues[port.id]
      const isHovered = hovering?.componentId === component.id && hovering?.port === port.id
      const isPending = interaction?.pendingWire?.fromComponentId === component.id && interaction?.pendingWire?.fromPortId === port.id
      drawPortGlyph(ctx, port, value, isHovered || isPending)
    }
  }

  drawContacts() {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    ctx.save()
    for (const arbiter of this.simulation.world.arbiters.values()) {
      for (const contact of arbiter.contacts) {
        ctx.beginPath()
        ctx.arc(contact.point.x, contact.point.y, 3.4 / Math.max(zoom, 0.4), 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(248,113,113,0.9)'
        ctx.fill()
        const n = arbiter.normal
        const length = 16 + Math.min(contact.normalImpulse * 0.01, 20)
        ctx.beginPath()
        ctx.moveTo(contact.point.x, contact.point.y)
        ctx.lineTo(contact.point.x + n.x * length, contact.point.y + n.y * length)
        ctx.strokeStyle = 'rgba(251,191,36,0.9)'
        ctx.lineWidth = 1.5 / Math.max(zoom, 0.4)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  drawAABBs() {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    ctx.save()
    ctx.lineWidth = 1 / zoom
    for (const body of this.simulation.world.bodies) {
      if (body.removed) continue
      const box = body.aabb
      ctx.strokeStyle = body.isFluid ? 'rgba(56,189,248,0.35)' : 'rgba(52,211,153,0.55)'
      ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY)
    }
    ctx.restore()
  }

  drawVelocities() {
    const ctx = this.ctx
    const zoom = this.camera.zoom
    ctx.save()
    ctx.strokeStyle = 'rgba(250,204,21,0.8)'
    ctx.lineWidth = 1.4 / Math.max(zoom, 0.4)
    for (const body of this.simulation.world.bodies) {
      if (body.removed || !body.isDynamic || body.velocity.lengthSq() < 4) continue
      ctx.beginPath()
      ctx.moveTo(body.position.x, body.position.y)
      ctx.lineTo(body.position.x + body.velocity.x * 0.08, body.position.y + body.velocity.y * 0.08)
      ctx.stroke()
    }
    ctx.restore()
  }
}

// --- helpers --------------------------------------------------------------
function portLayoutOf(component) {
  const bounds = component.getBounds()
  const width = Math.max(bounds.maxX - bounds.minX, 56)
  const height = Math.max(bounds.maxY - bounds.minY, 44)
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  const place = (ports, side) =>
    ports.map((port, index) => {
      const t = ports.length === 1 ? 0.5 : (index + 1) / (ports.length + 1)
      const localY = -height / 2 + height * t
      const localX = side === 'in' ? -width / 2 : width / 2
      const cos = Math.cos(component.rotation)
      const sin = Math.sin(component.rotation)
      return {
        ...port,
        side,
        index,
        position: new Vec2(cx + localX * cos - localY * sin, cy + localX * sin + localY * cos),
      }
    })
  return {
    inputs: place(component.ports.inputs, 'in'),
    outputs: place(component.ports.outputs, 'out'),
    bounds,
  }
}

function wirePathOf(from, to) {
  const dx = Math.abs(to.x - from.x)
  const bow = Math.max(34, Math.min(dx * 0.55, 180))
  return {
    c1: { x: from.x + bow, y: from.y },
    c2: { x: to.x - bow, y: to.y },
  }
}

function bezierPoint(p0, c1, c2, p3, t) {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  }
}

function drawPortGlyph(ctx, port, value, highlighted) {
  const size = 11
  const active =
    port.kind === 'digital' ? value === true : port.kind === 'text' ? !!value : Math.abs(Number(value) || 0) > 0.001
  ctx.save()
  ctx.translate(port.position.x, port.position.y)
  ctx.beginPath()
  ctx.rect(-size / 2, -size / 2, size, size)
  ctx.fillStyle = active ? '#0d2b1b' : '#141d2f'
  ctx.fill()
  ctx.lineWidth = highlighted ? 3 : 2
  ctx.strokeStyle = highlighted ? '#facc15' : active ? '#4ade80' : '#3b4f74'
  ctx.stroke()
  if (highlighted) {
    ctx.beginPath()
    ctx.arc(0, 0, size, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(250,204,21,0.4)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.restore()
}

export { lampColors }
