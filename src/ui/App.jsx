import { useCallback, useEffect, useRef, useState } from 'react'
import { createEngineHost } from './engineHost.js'
import { Toolbar } from './Toolbar.jsx'
import { Palette } from './Palette.jsx'
import { Inspector } from './Inspector.jsx'
import { StatusBar } from './StatusBar.jsx'
import { ProjectDialogs } from './ProjectDialogs.jsx'
import { loadProject, shortLinkId } from './api.js'

/**
 * The React shell.
 *
 * **Ownership contract** (the point of the whole exercise):
 *
 *   · the engine is created **once**, in an effect with an empty dependency
 *     array, and lives in a ref. React never re-creates it, never owns the
 *     canvas pixels and never drives the frame loop;
 *   · the canvas is handed to the engine as a plain DOM node — the engine calls
 *     `getContext('2d')` itself;
 *   · React state holds only *chrome*: which component is selected, whether the
 *     simulation is paused, undo depth, and the ~6 Hz status-bar numbers.
 *     Anything that changes at 60 Hz stays in the engine;
 *   · the inspector writes straight into the vanilla instance
 *     (`engine.updateProperty(...)`), so dragging a slider cannot cause a React
 *     render, let alone a frame drop.
 *
 * Selection travels the other way as a DOM `CustomEvent('entitySelected')`
 * dispatched on the canvas by `Engine.select()` — the same event a plain
 * vanilla page or an embedding host would listen for.
 */
export function App() {
  const canvasRef = useRef(null)
  const hostRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [stats, setStats] = useState(null)
  const [running, setRunning] = useState(true)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [demoId, setDemoId] = useState(null)
  const [dialog, setDialog] = useState(null) // 'save' | 'open' | null
  const [toast, setToast] = useState(null)
  const statsRef = useRef(0)

  // --- engine lifetime: exactly one Engine for the life of the page ---------
  useEffect(() => {
    const host = createEngineHost({
      canvas: canvasRef.current,
      onEvent: (event, payload) => {
        if (event !== 'stats') return
        // Throttle: the engine emits stats every frame; React only needs enough
        // to keep the status bar honest.
        const now = performance.now()
        if (now - statsRef.current < 160) return
        statsRef.current = now
        setStats({ ...payload })
      },
    })
    hostRef.current = host
    // Handy from the browser console, and it is how `npm run smoke` reaches the
    // running engine to drive the real controls. The engine itself stays vanilla:
    // nothing here is part of its API.
    if (canvasRef.current) canvasRef.current.__mechasimHost = host
    setDemoId(host.demos[0]?.id ?? null)
    setRunning(true)
    setReady(true)

    const canvas = canvasRef.current
    const onEntitySelected = (event) => setSelectedId(event.detail?.entityId ?? null)
    canvas.addEventListener('entitySelected', onEntitySelected)

    const unsubscribe = host.subscribe(() => {
      const engine = host.engine
      setSelectedId(engine.selectedComponent?.id ?? null)
      setRunning(engine.running)
      setHistory({ undo: engine.history.undo.length, redo: engine.history.redo.length })
    })

    // Short link `/s/<id>` → load that project instead of the default demo.
    const shared = shortLinkId()
    if (shared) {
      loadProject(shared)
        .then((payload) => {
          host.engine.load(payload)
          setDemoId(null)
          setToast(`Loaded shared project ${shared}`)
        })
        .catch((error) => setToast(`Could not load ${shared}: ${error.message}`))
    }

    return () => {
      canvas.removeEventListener('entitySelected', onEntitySelected)
      unsubscribe()
      host.dispose()
      hostRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(timer)
  }, [toast])

  const host = hostRef.current
  const engine = host?.engine ?? null

  const onAdd = useCallback((type, clientPoint) => {
    // NB: do not name this local `hostRef` — inside this scope that name would
    // shadow the ref itself and `hostRef.current` would throw a TDZ
    // ReferenceError the moment anyone clicked a palette entry.
    const running = hostRef.current
    if (!running) return
    const canvas = canvasRef.current
    const screen = clientPoint
      ? { x: clientPoint.x - canvas.getBoundingClientRect().left, y: clientPoint.y - canvas.getBoundingClientRect().top }
      : { x: (canvas?.clientWidth ?? 1280) / 2 + 40, y: (canvas?.clientHeight ?? 720) / 2 + 20 }
    const world = running.engine.camera.screenToWorld(screen.x, screen.y)
    running.engine.addComponent(type, { x: Math.round(world.x), y: Math.round(world.y) })
  }, [])

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('text/mechasim-type')
      if (type) onAdd(type, { x: event.clientX, y: event.clientY })
    },
    [onAdd],
  )

  const onDemo = useCallback((id) => {
    const running = hostRef.current
    if (!running) return
    running.loadDemo(id)
    setDemoId(id)
  }, [])

  return (
    <div className="app">
      <Toolbar
        engine={engine}
        host={host}
        demos={host?.demos ?? []}
        demoId={demoId}
        running={running}
        history={history}
        onDemo={onDemo}
        onSave={() => setDialog('save')}
        onOpen={() => setDialog('open')}
        onToast={setToast}
      />

      <Palette onAdd={onAdd} />

      <div className="stage" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <canvas ref={canvasRef} tabIndex={0} />
        <div className="stage-hint">
          drag parts in · drag ports to wire · space play/pause · F fit · R reset
          <br />
          scroll zoom · right-drag pan · click to inspect
        </div>
      </div>

      <Inspector engine={engine} selectedId={selectedId} stats={stats} />

      <StatusBar stats={stats} engine={engine} ready={ready} />

      {dialog && (
        <ProjectDialogs
          mode={dialog}
          engine={engine}
          onClose={() => setDialog(null)}
          onToast={setToast}
          onLoaded={() => setDemoId(null)}
        />
      )}

      {toast && (
        <div className="stage-hint" style={{ left: '50%', transform: 'translateX(-50%)', bottom: 20 }}>
          {toast}
        </div>
      )}
    </div>
  )
}
