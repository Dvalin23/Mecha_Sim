/**
 * Canvas drawing primitives shared by every component's `draw()`.
 * Everything here works in *world* space; the renderer's view transform has
 * already been applied, so a component only draws its own geometry.
 */

export function roundRect(ctx, x, y, w, h, r = 6) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

/** Panel body used by every device: dark plate + accent edge + title. */
export function drawPanel(ctx, component, options = {}) {
  const {
    fill = '#111a2b',
    stroke = component.accent,
    radius = 8,
    alpha = 1,
    lineWidth = 1.6,
    label = component.label,
  } = options
  const b = component.getBounds()
  // Components with physics bodies draw those separately; the panel is a
  // visual/backplate for the electronics.
  const pad = 4
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(component.position.x, component.position.y)
  ctx.rotate(component.rotation)
  const w = Math.max(b.maxX - b.minX, 48) + pad * 2
  const h = Math.max(b.maxY - b.minY, 36) + pad * 2
  roundRect(ctx, -w / 2, -h / 2, w, h, radius)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = lineWidth
  ctx.stroke()
  if (label) {
    ctx.fillStyle = stroke
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = alpha * 0.9
    ctx.fillText(label.toUpperCase(), 0, -h / 2 + 10)
  }
  ctx.restore()
}

/** Port glyph (small square) — colour encodes the live signal. */
export function drawPort(ctx, port, value, options = {}) {
  const size = options.size ?? 11
  const active =
    port.kind === 'digital' ? value === true : port.kind === 'text' ? !!value : Math.abs(value ?? 0) > 0.001
  ctx.save()
  ctx.translate(port.position.x, port.position.y)
  ctx.beginPath()
  ctx.rect(-size / 2, -size / 2, size, size)
  ctx.fillStyle = active ? '#0b1220' : '#1b2740'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = active ? (options.activeColor ?? '#4ade80') : options.idleColor ?? '#3b4f74'
  ctx.stroke()
  ctx.restore()
}

/** Small text tag anchored at a world position. */
export function drawTag(ctx, x, y, text, options = {}) {
  const { color = '#93b4d8', background = 'rgba(8,13,24,0.82)', font = '500 11px "JetBrains Mono", ui-monospace, monospace' } = options
  ctx.save()
  ctx.font = font
  const width = ctx.measureText(text).width + 12
  const height = 18
  roundRect(ctx, x - width / 2, y - height / 2, width, height, 5)
  ctx.fillStyle = background
  ctx.fill()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + 0.5)
  ctx.restore()
}

export function dashedLine(ctx, x1, y1, x2, y2, dash = [6, 6]) {
  ctx.save()
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

export function arrowHead(ctx, x, y, angle, size = 8, color = '#cbd5e1') {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.5)
  ctx.lineTo(-size, size * 0.5)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

/** Conical field-of-view wedge for the PIR sensor. */
export function drawCone(ctx, origin, angle, halfAngle, range, options = {}) {
  const { fill = 'rgba(250, 204, 21, 0.12)', stroke = 'rgba(250, 204, 21, 0.55)', lineWidth = 1 } = options
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(origin.x, origin.y)
  ctx.arc(origin.x, origin.y, range, angle - halfAngle, angle + halfAngle)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = lineWidth
  ctx.stroke()
  ctx.restore()
}

/** Seven-segment-ish readout used by the LCD and the debug HUD. */
export function drawReadout(ctx, x, y, text, options = {}) {
  const {
    color = '#67e8f9',
    align = 'left',
    font = '600 13px "JetBrains Mono", ui-monospace, monospace',
    alpha = 1,
  } = options
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** LED with bloom. */
export function drawLed(ctx, x, y, radius, on, options = {}) {
  const { onColor = '#4ade80', offColor = '#1e293b', glow = 14 } = options
  ctx.save()
  if (on) {
    const gradient = ctx.createRadialGradient(x, y, radius * 0.4, x, y, radius + glow)
    gradient.addColorStop(0, `${onColor}cc`)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius + glow, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = on ? onColor : offColor
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
}

/** Hatch pattern for static terrain (visual language for "immovable"). */
export function hatchRect(ctx, x, y, w, h, spacing = 12, color = 'rgba(148,163,184,0.22)') {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = -h; i < w; i += spacing) {
    ctx.moveTo(x + i, y + h)
    ctx.lineTo(x + i + h, y)
  }
  ctx.stroke()
  ctx.restore()
}

export const formatValue = (value, kind) => {
  if (kind === 'digital') return value ? 'HIGH' : 'LOW'
  if (kind === 'text') return String(value ?? '')
  if (!Number.isFinite(value)) return '—'
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2)
}
