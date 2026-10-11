import { clamp } from './math/utils.js'

/**
 * 2D camera: world ⇄ screen transform with pan and zoom.
 *
 * The renderer applies the transform once (`ctx.translate/scale`) so every draw
 * call downstream works in world units — components never think about zoom.
 */
export class Camera {
  constructor(options = {}) {
    const { x = 800, y = 450, zoom = 1, minZoom = 0.2, maxZoom = 4 } = options
    this.x = x
    this.y = y
    this.zoom = zoom
    this.minZoom = minZoom
    this.maxZoom = maxZoom
    this.viewportWidth = 1280
    this.viewportHeight = 720
  }

  setViewport(width, height) {
    this.viewportWidth = width
    this.viewportHeight = height
    return this
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.zoom + this.viewportWidth / 2,
      y: (y - this.y) * this.zoom + this.viewportHeight / 2,
    }
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewportWidth / 2) / this.zoom + this.x,
      y: (sy - this.viewportHeight / 2) / this.zoom + this.y,
    }
  }

  /** Visible world-space rectangle (for culling and grid generation). */
  get visibleBounds() {
    const halfW = this.viewportWidth / 2 / this.zoom
    const halfH = this.viewportHeight / 2 / this.zoom
    return {
      minX: this.x - halfW,
      minY: this.y - halfH,
      maxX: this.x + halfW,
      maxY: this.y + halfH,
      width: halfW * 2,
      height: halfH * 2,
    }
  }

  /** Pan by a screen-space delta (called while dragging the background). */
  panByScreen(dx, dy) {
    this.x -= dx / this.zoom
    this.y -= dy / this.zoom
    return this
  }

  panByWorld(dx, dy) {
    this.x += dx
    this.y += dy
    return this
  }

  /** Zoom about a screen-space anchor (usually the cursor). */
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY)
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom)
    const after = this.screenToWorld(screenX, screenY)
    this.x += before.x - after.x
    this.y += before.y - after.y
    return this
  }

  setZoom(zoom) {
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom)
    return this
  }

  /** Frame a world-space bounding box. */
  fit(bounds, padding = 80) {
    if (!bounds) return this
    const width = Math.max(bounds.maxX - bounds.minX, 1)
    const height = Math.max(bounds.maxY - bounds.minY, 1)
    const zoomX = (this.viewportWidth - padding * 2) / width
    const zoomY = (this.viewportHeight - padding * 2) / height
    this.zoom = clamp(Math.min(zoomX, zoomY), this.minZoom, this.maxZoom)
    this.x = (bounds.minX + bounds.maxX) / 2
    this.y = (bounds.minY + bounds.maxY) / 2
    return this
  }

  centerOn(x, y) {
    this.x = x
    this.y = y
    return this
  }

  /** Push the engine's transform onto the canvas context. */
  apply(ctx) {
    ctx.translate(this.viewportWidth / 2, this.viewportHeight / 2)
    ctx.scale(this.zoom, this.zoom)
    ctx.translate(-this.x, -this.y)
    return this
  }

  serialize() {
    return { x: round(this.x), y: round(this.y), zoom: round(this.zoom, 3) }
  }

  deserialize(data) {
    if (!data) return this
    this.x = data.x ?? this.x
    this.y = data.y ?? this.y
    this.zoom = clamp(data.zoom ?? this.zoom, this.minZoom, this.maxZoom)
    return this
  }
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d
