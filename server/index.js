import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import express from 'express'
import { createApiRouter } from './api.js'
import { ProjectStore } from './store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Start the production server (or the dev middleware server).
 *
 * `mode: 'dev'` lazily imports Vite and mounts it as middleware in front of the
 * same API router, so both modes serve one origin: the browser talks to
 * `/api/...` with a relative URL and never has to know which mode it is in.
 * That also keeps the sandbox preview working — the proxy only ever sees one
 * port.
 */
export async function startServer({
  port = Number(process.env.PORT ?? 5173),
  host = process.env.HOST ?? '0.0.0.0',
  mode = process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
  store = new ProjectStore(),
} = {}) {
  await store.init()

  const app = express()
  app.disable('x-powered-by')
  app.use('/api', createApiRouter({ store }))
  app.use('/s/:id', sendIndexFallback) // short links are client-side routes

  let vite = null
  if (mode === 'dev') {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      root,
      server: { middlewareMode: true, host, port },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  } else {
    const dist = join(root, 'dist')
    if (!existsSync(dist)) {
      console.warn('[mechasim] dist/ is missing — run `npm run build` first.')
    }
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')))
  }

  const server = createServer(app)
  await new Promise((ok) => server.listen(port, host, ok))

  const address = server.address()
  return {
    server,
    vite,
    store,
    mode,
    port: typeof address === 'object' && address ? address.port : port,
    host,
    async close() {
      if (vite) await vite.close()
      await new Promise((ok) => server.close(ok))
    },
  }
}

function sendIndexFallback(req, res, next) {
  // Compiled SPA in production; in dev Vite's middleware rewrites index.html.
  const dist = join(root, 'dist', 'index.html')
  if (existsSync(dist)) return res.sendFile(dist)
  next()
}

// `node server/index.js` boots directly; importing the module must not.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, mode } = await startServer()
  console.log(`[mechasim] ${mode} server listening on http://localhost:${port}`)
}
