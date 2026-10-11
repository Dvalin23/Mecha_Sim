import { useState } from 'react'

const DEBUG_FLAGS = [
  ['grid', 'Grid'],
  ['hash', 'Hash'],
  ['particles', 'Fluid'],
  ['contacts', 'Contacts'],
  ['aabb', 'AABBs'],
  ['velocity', 'Vectors'],
]

/**
 * Command bar. Everything here is a thin imperative call into the engine; the
 * only React state is what the buttons themselves display.
 */
export function Toolbar({ engine, host, demos, demoId, running, history, onDemo, onSave, onOpen, onToast }) {
  const [timeScale, setTimeScale] = useState(1)
  const [gravity, setGravity] = useState(9.81)
  const [debug, setDebug] = useState(() => ({ ...(engine?.renderer?.debug ?? {}) }))

  const toggleDebug = (flag) => {
    if (!engine?.renderer) return
    const next = { ...debug, [flag]: !debug[flag] }
    Object.assign(engine.renderer.debug, next)
    setDebug(next)
  }

  return (
    <header className="toolbar">
      <div className="brand">
        <b>MechaSim</b>
        <span>vanilla physics · react chrome</span>
      </div>

      <span className="sep" />

      <button className="btn primary" onClick={() => host?.toggle()} title="Space">
        {running ? '❚❚ Pause' : '▶ Run'}
      </button>
      <button className="btn" onClick={() => host?.step()} title="Advance one fixed 16.6 ms step">
        ⏭ Step
      </button>
      <button className="btn" onClick={() => host?.reset()} title="R — restore the scene's initial state">
        ⟲ Reset
      </button>

      <span className="sep" />

      <button className="btn icon" onClick={() => host?.undo()} disabled={!history.undo} title="Ctrl+Z">
        ↶
      </button>
      <button className="btn icon" onClick={() => host?.redo()} disabled={!history.redo} title="Ctrl+Shift+Z">
        ↷
      </button>
      <button className="btn" onClick={() => host?.fit()} title="F">
        ⤢ Fit
      </button>

      <span className="sep" />

      <label className="field">
        Scene
        <select value={demoId ?? ''} onChange={(event) => onDemo(event.target.value)}>
          {!demoId && <option value="">— loaded project —</option>}
          {demos.map((demo) => (
            <option key={demo.id} value={demo.id}>
              {demo.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Time
        <input
          type="range"
          min="0.1"
          max="2"
          step="0.1"
          value={timeScale}
          onChange={(event) => {
            const value = Number(event.target.value)
            setTimeScale(value)
            host?.setTimeScale(value)
          }}
        />
        <span className="value">{timeScale.toFixed(1)}×</span>
      </label>

      <label className="field">
        Gravity
        <input
          type="range"
          min="0"
          max="25"
          step="0.5"
          value={gravity}
          onChange={(event) => {
            const value = Number(event.target.value)
            setGravity(value)
            engine?.simulation.setGravity(value * 100)
          }}
        />
        <span className="value">{gravity.toFixed(1)}</span>
      </label>

      <span className="sep" />

      {DEBUG_FLAGS.map(([flag, label]) => (
        <button
          key={flag}
          className="btn"
          style={debug[flag] ? { borderColor: '#2b6f96', background: 'rgba(56,189,248,0.14)' } : undefined}
          onClick={() => toggleDebug(flag)}
        >
          {label}
        </button>
      ))}

      <span className="spacer" />

      <button className="btn" onClick={() => onToast(`Scene has ${engine?.componentCount ?? 0} components`)}>
        ⓘ
      </button>
      <button className="btn" onClick={onOpen}>
        Open
      </button>
      <button className="btn primary" onClick={onSave}>
        Save &amp; share
      </button>
    </header>
  )
}
