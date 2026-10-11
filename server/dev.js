import { startServer } from './index.js'

/**
 * Dev entry point: `npm run dev`.
 *
 * Boots the same Express app as production, with Vite mounted as middleware in
 * front of it. One process, one origin — the browser fetches `/api/...` with a
 * relative URL in both modes, and the sandbox preview only has to proxy a single
 * port. `vite.config.js` sets `host: '0.0.0.0'` and `allowedHosts: true` so the
 * proxied preview host is accepted.
 */
const { port, mode } = await startServer({ mode: 'dev' })

const banner = [
  '',
  '  ███  MechaSim — 2D physics + virtual mechatronics',
  `  ${mode} server  →  local http://localhost:${port}`,
  '  API          →  POST /api/projects/save · GET /api/projects/:id',
  '',
].join('\n')

console.log(banner)
