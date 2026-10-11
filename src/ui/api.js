/**
 * Thin client for the sharing API. All URLs are relative: the Vite dev server
 * and the production Express server both serve the app and the API from one
 * origin, so the browser never needs to know where the backend lives.
 */
const json = async (response) => {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`)
    error.issues = body.issues ?? []
    error.status = response.status
    throw error
  }
  return body
}

export async function saveProject(payload) {
  return json(
    await fetch('/api/projects/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function listProjects() {
  const { projects } = await json(await fetch('/api/projects'))
  return projects
}

export async function loadProject(id) {
  return json(await fetch(`/api/projects/${encodeURIComponent(id)}`))
}

export async function deleteProject(id) {
  return json(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

/** Project id from a `/s/<id>` short link, if the app was opened through one. */
export function shortLinkId(pathname = window.location.pathname) {
  const match = pathname.match(/^\/s\/([A-Za-z0-9_-]{4,40})\/?$/)
  return match ? match[1] : null
}
