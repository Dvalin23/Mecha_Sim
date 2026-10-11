import { Router, json } from 'express'
import { validateProject, formatZodIssues } from '../shared/schema.js'
import { upgradePayload } from '../src/engine/serialization.js'
import { ProjectStore } from './store.js'

/**
 * The HTTP surface of the sharing pipeline.
 *
 * The same router is mounted by both the Vite dev middleware server and the
 * production Express server — there is exactly one implementation of the API, so
 * "works in dev, 500s in prod" cannot happen by construction.
 *
 * Trust model: **the client is untrusted input.** Every write goes through
 * `validateProject()` (Zod, shared with the frontend so the two sides cannot
 * disagree about the contract) *before* it reaches storage, and payloads larger
 * than `maxPayloadBytes` are rejected by the body parser rather than buffered.
 */
export function createApiRouter({ store = new ProjectStore(), baseUrl = '' } = {}) {
  const router = Router()
  const limit = '2mb'

  router.use(json({ limit }))

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mechasim', time: new Date().toISOString() })
  })

  /** Save (create or overwrite) a project. Returns the short link. */
  router.post('/projects/save', async (req, res) => {
    const result = validateProject(req.body)
    if (!result.ok) {
      return res.status(422).json({ ok: false, error: 'validation_failed', issues: result.errors })
    }
    const payload = result.data
    // A payload may carry a client-minted id; otherwise the store allocates one.
    const id = payload.simulationId && /^[A-Za-z0-9_-]{4,40}$/.test(payload.simulationId)
      ? payload.simulationId
      : await store.allocateId()
    try {
      const record = await store.save(id, payload)
      res.status(201).json({
        ok: true,
        id,
        url: `${baseUrl}/s/${id}`,
        api: `${baseUrl}/api/projects/${id}`,
        savedAt: record.savedAt,
        nodes: record.nodes.length,
        edges: record.edges.length,
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: 'save_failed', message: error.message })
    }
  })

  /** Fetch a stored project, upgraded to the current format if it is old. */
  router.get('/projects/:id', async (req, res) => {
    let record
    try {
      record = await store.load(req.params.id)
    } catch (error) {
      return res.status(400).json({ ok: false, error: 'bad_id', message: error.message })
    }
    if (!record) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json(upgradePayload(record))
  })

  /** Summaries for the open dialog. */
  router.get('/projects', async (_req, res) => {
    try {
      res.json({ ok: true, projects: await store.list() })
    } catch (error) {
      res.status(500).json({ ok: false, error: 'list_failed', message: error.message })
    }
  })

  router.delete('/projects/:id', async (req, res) => {
    const removed = await store.remove(req.params.id)
    if (!removed) return res.status(404).json({ ok: false, error: 'not_found' })
    res.json({ ok: true, id: req.params.id })
  })

  /** Dry-run validation — lets the UI lint a scene without saving it. */
  router.post('/validate', (req, res) => {
    const result = validateProject(req.body)
    res.status(result.ok ? 200 : 422).json(result.ok ? { ok: true } : { ok: false, issues: result.errors })
  })

  // A malformed JSON body reaches the error handler instead of exploding.
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  router.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'payload_too_large' })
    }
    if (error instanceof SyntaxError) {
      return res.status(400).json({ ok: false, error: 'invalid_json', issues: formatZodIssues(error) })
    }
    res.status(500).json({ ok: false, error: 'internal_error', message: error?.message })
  })

  return router
}
