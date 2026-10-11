import { useEffect, useState } from 'react'
import { listProjects, loadProject, saveProject } from './api.js'
import { validateProject } from '../../shared/schema.js'

/**
 * Save / open dialogs for the sharing pipeline.
 *
 * The save flow is the same contract the server enforces: build the payload with
 * `engine.serialize()` **on the vanilla simulation**, then run it through the
 * very same Zod schema the API uses (`shared/schema.js`). The browser therefore
 * rejects a malformed scene with the same message the server would have
 * returned, and the round trip demonstrates the serialization design: cyclic
 * `relay → motor → relay` wiring flattens to UUID strings on the wire.
 */
export function ProjectDialogs({ mode, engine, onClose, onToast, onLoaded }) {
  const [name, setName] = useState(engine?.simulation.name ?? 'Untitled Simulation')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState([])
  const [result, setResult] = useState(null)
  const [projects, setProjects] = useState([])
  const [preview, setPreview] = useState('')

  useEffect(() => {
    if (mode === 'open') {
      listProjects()
        .then(setProjects)
        .catch((error) => setIssues([{ path: 'api', message: error.message }]))
    }
    if (mode === 'save' && engine) setPreview(JSON.stringify(engine.serialize({ name }), null, 2))
  }, [mode, engine, name])

  const onSave = async () => {
    if (!engine) return
    const payload = engine.serialize({ name, description })
    const checked = validateProject(payload)
    if (!checked.ok) {
      setIssues(checked.errors)
      return
    }
    setIssues([])
    setBusy(true)
    try {
      const response = await saveProject(payload)
      setResult({ ...response, url: `${window.location.origin}${response.url}` })
      onToast(`Saved ${response.nodes} nodes / ${response.edges} wires → ${response.id}`)
    } catch (error) {
      setIssues(error.issues.length ? error.issues : [{ path: 'api', message: error.message }])
    } finally {
      setBusy(false)
    }
  }

  const onOpen = async (id) => {
    setBusy(true)
    try {
      const payload = await loadProject(id)
      engine.load(payload)
      onLoaded?.()
      onToast(`Loaded ${payload.name} (${payload.nodes.length} nodes)`)
      onClose()
    } catch (error) {
      setIssues([{ path: 'api', message: error.message }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal">
        <header>{mode === 'save' ? 'Save & share' : 'Open project'}</header>

        <div className="body">
          {mode === 'save' ? (
            <>
              <label className="field" style={{ display: 'grid', gap: 5 }}>
                Name
                <input type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="field" style={{ display: 'grid', gap: 5 }}>
                Description
                <input
                  type="text"
                  value={description}
                  maxLength={600}
                  placeholder="What does this machine do?"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="hint">
                The payload below is what leaves the browser: memory references already replaced by UUID
                strings, geometry kept as structure plus a compact list of water fills. It is validated
                against the shared Zod schema before it is sent, and validated again by the server.
              </div>
              <details>
                <summary className="hint">payload preview ({engine?.componentCount ?? 0} nodes)</summary>
                <textarea readOnly value={preview} />
              </details>
            </>
          ) : (
            <>
              <div className="hint">Projects stored by this server:</div>
              <div className="list">
                {projects.length === 0 && <div className="hint">Nothing saved yet.</div>}
                {projects.map((project) => (
                  <button key={project.id} onClick={() => onOpen(project.id)} disabled={busy}>
                    <span className="name">{project.name}</span>
                    <span className="sub">
                      {project.id} · {project.nodes} nodes · {project.edges} wires ·{' '}
                      {(project.size / 1024).toFixed(1)} kB · {formatDate(project.savedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {issues.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {issues.slice(0, 8).map((issue, index) => (
                <div key={index} className="hint">
                  <span className="badge bad">{issue.path}</span> {issue.message}
                </div>
              ))}
            </div>
          )}

          {result && (
            <>
              <div className="hint">
                Saved. The short link loads the project straight from <code>/s/{result.id}</code>:
              </div>
              <div className="link-row">
                <input type="text" readOnly value={result.url} onFocus={(event) => event.target.select()} />
                <button
                  className="btn"
                  onClick={() => {
                    navigator.clipboard?.writeText(result.url)
                    onToast('Link copied')
                  }}
                >
                  Copy
                </button>
                <a className="btn" href={result.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
            </>
          )}
        </div>

        <footer>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {mode === 'save' && (
            <button className="btn primary" onClick={onSave} disabled={busy}>
              {busy ? 'Saving…' : 'Validate & save'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

const formatDate = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}
