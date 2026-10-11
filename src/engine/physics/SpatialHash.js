import { AABB } from './shapes.js'

/**
 * Uniform-grid spatial hash — the broad phase.
 *
 * The world is diced into fixed-size cells; every body registers its AABB into
 * every cell it overlaps, so collision candidates are only generated between
 * bodies sharing a cell (or an edge, since AABBs are rasterised into all cells
 * they touch). Cost per step is O(n·k) where k is the local occupancy, which is
 * what takes the pipeline from the naive O(n²) all-pairs sweep (300 droplets →
 * 44 850 comparisons/frame) down to a few thousand.
 *
 * Cells are stored in a `Map<number, Body[]>` keyed by a packed 32-bit cell
 * index so there is no string hashing in the hot path.
 */
export class SpatialHash {
  constructor({ cellSize = 96, bounds = null, maxBodies = 1 << 20 } = {}) {
    this.cellSize = cellSize
    this.invCellSize = 1 / cellSize
    this.bounds = bounds
    this.maxBodies = maxBodies
    this.cells = new Map()
    this.bodyCount = 0
    this._queryStamp = 1
    this._pairKeys = new Set()
    this._pairs = []
    this.stats = { occupiedCells: 0, candidatePairs: 0, broadPhaseMs: 0 }
  }

  clear() {
    this.cells.clear()
    this._pairKeys.clear()
    this._pairs.length = 0
    this.bodyCount = 0
  }

  // --- cell index packing -------------------------------------------------
  static key(cx, cy) {
    // Cantor-ish packing: exact for |cx|,|cy| < 2^15, and negative-safe.
    return ((cx + 32768) << 16) | ((cy + 32768) & 0xffff)
  }

  cellCoord(value) {
    return Math.floor(value * this.invCellSize)
  }

  /** Insert one body into every cell its current AABB touches. */
  insert(body) {
    if (!body.enabled || body.removed) return
    const box = body.aabb
    const minX = this.cellCoord(box.minX)
    const maxX = this.cellCoord(box.maxX)
    const minY = this.cellCoord(box.minY)
    const maxY = this.cellCoord(box.maxY)
    // Very large shapes (level walls) would smear across hundreds of cells; they
    // are rare, so we tag them as "global" and clip them against every candidate
    // instead of rasterising.
    const span = (maxX - minX + 1) * (maxY - minY + 1)
    if (span > 256) {
      body._globalCell = true
      const key = SpatialHash.key(-1, -1)
      let bucket = this.cells.get(key)
      if (!bucket) {
        bucket = []
        this.cells.set(key, bucket)
      }
      bucket.push(body)
      this.bodyCount++
      return
    }
    body._globalCell = false
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const key = SpatialHash.key(cx, cy)
        let bucket = this.cells.get(key)
        if (!bucket) {
          bucket = []
          this.cells.set(key, bucket)
        }
        bucket.push(body)
      }
    }
    this.bodyCount++
  }

  /**
   * Generate every unique overlapping-ish pair.
   *
   * Dedupe strategy: a monotonic stamp stored on the body avoids the Set churn
   * of string keys; a packed integer pair key keeps `Set<number>` cheap.
   */
  forEachPair(callback) {
    const t0 = performance.now()
    this._pairKeys.clear()
    const pairs = this._pairs
    pairs.length = 0
    const globalBucket = this.cells.get(SpatialHash.key(-1, -1))

    const consider = (a, b) => {
      if (a === b || a.removed || b.removed) return
      if (!a.enabled || !b.enabled) return
      if (!a.isDynamic && !b.isDynamic) return // static/static and static/kinematic
      if ((a.layer & b.mask) === 0 || (b.layer & a.mask) === 0) return
      if (a.awake === false && b.awake === false) return
      if (!a.aabb.overlaps(b.aabb)) return
      // Packed unique key: uid < 2^20 (~1.05M bodies) keeps the shift exact.
      const lo = a.uid < b.uid ? a.uid : b.uid
      const hi = a.uid < b.uid ? b.uid : a.uid
      const key = lo * 1048576 + hi
      if (this._pairKeys.has(key)) return
      this._pairKeys.add(key)
      pairs.push(a, b)
      callback(a, b)
    }

    // 1) In-cell pairs.
    for (const bucket of this.cells.values()) {
      if (bucket === globalBucket) continue
      const n = bucket.length
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = bucket[i]
          const b = bucket[j]
          if (a._globalCell || b._globalCell) continue // handled in pass 2
          consider(a, b)
        }
      }
    }

    // 2) Oversized bodies (level geometry) against everything in their cells.
    if (globalBucket) {
      for (const big of globalBucket) {
        const box = big.aabb
        const minX = Math.max(this.cellCoord(box.minX), -32767)
        const maxX = Math.min(this.cellCoord(box.maxX), 32766)
        const minY = Math.max(this.cellCoord(box.minY), -32767)
        const maxY = Math.min(this.cellCoord(box.maxY), 32766)
        for (let cx = minX; cx <= maxX; cx++) {
          for (let cy = minY; cy <= maxY; cy++) {
            const bucket = this.cells.get(SpatialHash.key(cx, cy))
            if (!bucket) continue
            for (const other of bucket) {
              if (other === big || other._globalCell) continue
              consider(big, other)
            }
          }
        }
      }
    }

    this.stats.occupiedCells = this.cells.size
    this.stats.candidatePairs = pairs.length / 2
    this.stats.broadPhaseMs = performance.now() - t0
  }

  /** Point query (mouse picking, LCD hit tests). Fills `out` from scratch. */
  queryPoint(x, y, out = []) {
    out.length = 0
    const cx = this.cellCoord(x)
    const cy = this.cellCoord(y)
    const bucket = this.cells.get(SpatialHash.key(cx, cy))
    const globalBucket = this.cells.get(SpatialHash.key(-1, -1))
    if (bucket) for (const body of bucket) out.push(body)
    if (globalBucket) for (const body of globalBucket) out.push(body)
    return out
  }

  /**
   * AABB query (region triggers, pump influence volumes).
   * `out` is *replaced*, not appended to — callers may safely pass a pooled
   * scratch array for the whole frame.
   */
  queryAABB(box, out = []) {
    out.length = 0
    const stamp = ++this._queryStamp
    const minX = this.cellCoord(box.minX)
    const maxX = this.cellCoord(box.maxX)
    const minY = this.cellCoord(box.minY)
    const maxY = this.cellCoord(box.maxY)
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const bucket = this.cells.get(SpatialHash.key(cx, cy))
        if (!bucket) continue
        for (const body of bucket) {
          if (body._queryStamp === stamp || body.removed) continue
          body._queryStamp = stamp
          if (body.aabb.overlaps(box)) out.push(body)
        }
      }
    }
    const globalBucket = this.cells.get(SpatialHash.key(-1, -1))
    if (globalBucket) {
      for (const body of globalBucket) {
        if (body._queryStamp === stamp || body.removed) continue
        body._queryStamp = stamp
        if (body.aabb.overlaps(box)) out.push(body)
      }
    }
    return out
  }

  /** Iterate only the cells a ray segment physically enters (DDA order). */
  *rayCells(ox, oy, dx, dy, maxDistance) {
    if (maxDistance <= 0) return
    let cx = this.cellCoord(ox)
    let cy = this.cellCoord(oy)
    const stepX = dx > 0 ? 1 : -1
    const stepY = dy > 0 ? 1 : -1
    const cellSize = this.cellSize
    const nextBoundaryX = (cx + (dx > 0 ? 1 : 0)) * cellSize
    const nextBoundaryY = (cy + (dy > 0 ? 1 : 0)) * cellSize
    let tMaxX = dx !== 0 ? (nextBoundaryX - ox) / dx : Infinity
    let tMaxY = dy !== 0 ? (nextBoundaryY - oy) / dy : Infinity
    const tDeltaX = dx !== 0 ? Math.abs(cellSize / dx) : Infinity
    const tDeltaY = dy !== 0 ? Math.abs(cellSize / dy) : Infinity
    let travelled = 0
    let guard = 0
    const maxCells = 4096
    while (travelled <= maxDistance && guard++ < maxCells) {
      yield { cx, cy, enterDistance: travelled }
      if (tMaxX < tMaxY) {
        travelled = tMaxX
        tMaxX += tDeltaX
        cx += stepX
      } else {
        travelled = tMaxY
        tMaxY += tDeltaY
        cy += stepY
      }
    }
  }

  /** Spatial hash density, for the debug overlay. */
  getStats() {
    let max = 0
    for (const bucket of this.cells.values()) max = Math.max(max, bucket.length)
    return {
      cells: this.cells.size,
      bodies: this.bodyCount,
      maxOccupancy: max,
      candidatePairs: this.stats.candidatePairs,
      broadPhaseMs: this.stats.broadPhaseMs,
    }
  }
}

export { AABB }
