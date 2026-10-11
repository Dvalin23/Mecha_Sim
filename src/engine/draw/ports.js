import { Vec2 } from '../math/Vec2.js'

export const PORT_SIZE = 11

/**
 * Deterministic port layout.
 *
 * Ports are laid out on the vertical edges of a component's bounds: inputs on
 * the left, outputs on the right. Both the renderer (to draw wires) and the
 * input handler (to start a wire by clicking a port) derive geometry from this
 * single function so the hit target always matches the glyph.
 */
export function getPortPositions(component) {
  const bounds = component.getBounds()
  const width = Math.max(bounds.maxX - bounds.minX, 56)
  const height = Math.max(bounds.maxY - bounds.minY, 40)
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  const halfW = width / 2
  const halfH = height / 2

  const place = (ports, side) => {
    const count = ports.length
    return ports.map((port, index) => {
      // Spread across the edge, inset from the corners.
      const t = count === 1 ? 0.5 : (index + 1) / (count + 1)
      const localY = -halfH + height * t
      const cos = Math.cos(component.rotation)
      const sin = Math.sin(component.rotation)
      const localX = side === 'in' ? -halfW : halfW
      return {
        ...port,
        side,
        index,
        position: new Vec2(cx + localX * cos - localY * sin, cy + localX * sin + localY * cos),
      }
    })
  }

  return {
    inputs: place(component.ports.inputs, 'in'),
    outputs: place(component.ports.outputs, 'out'),
    bounds,
  }
}

/** Find the port under a world-space point (used by the wire tool). */
export function hitTestPort(component, worldPoint, tolerance = PORT_SIZE) {
  const layout = getPortPositions(component)
  for (const port of [...layout.inputs, ...layout.outputs]) {
    if (port.position.distanceTo(worldPoint) <= tolerance) return port
  }
  return null
}

/**
 * Cubic Bézier control points for a wire, biased horizontally so signals read
 * like PCB traces rather than rubber bands.
 */
export function wirePath(from, to) {
  const dx = Math.abs(to.x - from.x)
  const bow = Math.max(34, Math.min(dx * 0.55, 180))
  return {
    c1: { x: from.x + bow, y: from.y },
    c2: { x: to.x - bow, y: to.y },
  }
}

/** Sample a point along the wire (used for the animated signal pulse). */
export function pointOnWire(from, to, t) {
  const { c1, c2 } = wirePath(from, to)
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
