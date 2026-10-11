import { mkdir, readFile, writeFile, readdir, unlink, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shortId } from '../src/engine/ids.js'

/**
 * Project store — a tiny, dependency-free JSON document store.
 *
 * Two requirements drive the shape of this module:
 *
 *  1. **Short links.** A shared scene must be reachable at `/s/7f3kQ2p1`, so the
 *     id has to be readable *and* unguessable enough for a public demo. It is
 *     generated from a 32-bit PRNG and collision-checked against the directory.
 *  2. **Atomic writes.** A save is `write temp file → rename`, so a crash mid
 *     write can never leave a half-written scene behind for the next reader.
 *
 * The store keeps one file per project: `data/projects/<id>.json`. That makes
 * listing, exporting and hand-inspecting trivial, and it means the whole thing
 * can be swapped for Postgres/S3 later without touching the HTTP layer — the
 * routes only ever see the four methods below.
 */
export class ProjectStore {
  constructor({ directory = resolve(process.cwd(), 'data/projects'), maxProjects = 5000 } = {}) {
    this.directory = directory
    this.maxProjects = maxProjects
    this._ready = null
    /** Ids minted this process, so two saves in the same millisecond can't clash. */
    this._issued = new Set()
  }

  async init() {
    this._ready ??= mkdir(this.directory, { recursive: true })
    await this._ready
    return this
  }

  path(id) {
    // Defence in depth: the Zod schema already forbids anything but [A-Za-z0-9_-],
    // but the store is also used directly by scripts, so it re-checks.
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw new Error(`unsafe project id: ${id}`)
    return join(this.directory, `${id}.json`)
  }

  /** Allocate an unused short id. */
  async allocateId() {
    await this.init()
    for (let attempt = 0; attempt < 24; attempt++) {
      const id = shortId(attempt < 8 ? 8 : 12)
      if (this._issued.has(id)) continue
      try {
        await stat(this.path(id))
        continue // already on disk
      } catch {
        this._issued.add(id)
        return id
      }
    }
    throw new Error('could not allocate a project id')
  }

  async save(id, payload) {
    await this.init()
    const target = this.path(id)
    const temp = `${target}.${process.pid}.tmp`
    const record = { ...payload, simulationId: id, savedAt: new Date().toISOString() }
    await writeFile(temp, JSON.stringify(record), 'utf8')
    await rename(temp, target) // atomic replace
    return record
  }

  async load(id) {
    await this.init()
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async remove(id) {
    await this.init()
    try {
      await unlink(this.path(id))
      this._issued.delete(id)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  /** Summaries only — never the payload — for the "open" dialog. */
  async list({ limit = 60 } = {}) {
    await this.init()
    let files
    try {
      files = await readdir(this.directory)
    } catch {
      return []
    }
    const records = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const payload = JSON.parse(await readFile(join(this.directory, file), 'utf8'))
        records.push({
          id: payload.simulationId ?? file.replace(/\.json$/, ''),
          name: payload.name ?? 'Untitled Simulation',
          description: payload.description ?? '',
          nodes: payload.nodes?.length ?? 0,
          edges: payload.edges?.length ?? 0,
          savedAt: payload.savedAt ?? payload.updatedAt ?? null,
          size: Buffer.byteLength(JSON.stringify(payload)),
        })
      } catch {
        // A corrupt file must not take the whole listing down.
      }
    }
    records.sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')))
    return records.slice(0, limit)
  }

  async count() {
    return (await this.list({ limit: this.maxProjects + 1 })).length
  }
}
