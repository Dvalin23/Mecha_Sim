import { useEffect, useMemo, useRef, useState } from 'react'
import { portColors } from '../engine/draw/palette.js'

/**
 * Inspector panel.
 *
 * The interesting constraint: a slider must move a *physical* value, and the
 * simulation must not stutter while it does. So an edit never becomes React
 * state — `onInput` calls `engine.updateProperty(component, key, value)`, which
 * writes straight onto the vanilla ES6 instance (and, for things like a tank's
 * dimensions or a controller's rule list, runs that class's own
 * `handlePropertyChange`). React is re-rendered only by the 8 Hz readout tick,
 * and the inputs are uncontrolled, so dragging is completely decoupled from the
 * component tree.
 *
 * Live values are shown from `component.state` — the same snapshot the probes
 * and the oscilloscope read.
 */
export function Inspector({ engine, selectedId, stats }) {
  const component = useMemo(
    () => (engine && selectedId ? engine.simulation.get(selectedId) : null),
    [engine, selectedId],
  )
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!component) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 125)
    return () => clearInterval(timer)
  }, [component])

  if (!engine) return <aside className="inspector" />
  if (!component) {
    return (
      <aside className="inspector">
        <div className="empty">
          <b>Nothing selected.</b>
          <br />
          Click a component on the canvas to inspect and tune it, or drag one in
          from the palette.
          <br />
          <br />
          {stats && (
            <>
              <span className="kv"><span>bodies</span><span>{stats.bodies}</span></span>
              <span className="kv"><span>fluid</span><span>{stats.fluid}</span></span>
              <span className="kv"><span>contacts</span><span>{stats.contacts}</span></span>
            </>
          )}
        </div>
      </aside>
    )
  }

  const Ctor = component.constructor
  const controls = Ctor.controls ?? []
  const probes = Ctor.probes ?? []
  const ports = component.ports
  const state = component.readState?.() ?? component.state ?? {}

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div className="type">
          <span style={{ color: component.accent }}>{Ctor.icon} </span>
          {Ctor.label}
        </div>
        <div className="meta">
          {component.type} · {Math.round(component.position.x)}, {Math.round(component.position.y)} · {(
            (component.rotation * 180) / Math.PI
          ).toFixed(0)}
          °
        </div>
        <div className="meta">
          <span className="badge">{Ctor.phase}</span>{' '}
          <span className="badge">{component.bodies.length} body</span>{' '}
          {component.selected && <span className="badge good">selected</span>}
        </div>
      </div>

      <div className="section-title">Properties</div>
      {controls.map((control) => (
        <ControlRow key={control.key} control={control} component={component} engine={engine} />
      ))}

      {ports.inputs.length + ports.outputs.length > 0 && (
        <>
          <div className="section-title">Ports</div>
          <div className="ports">
            {ports.inputs.map((port) => (
              <div key={`in-${port.id}`} className={`port in ${port.kind === 'text' ? 'text' : ''}`}>
                <span className="dot" />
                <span className="name">{port.label}</span>
                <span className="live" style={{ color: portColors[port.kind] }}>
                  {format(component.inputValues?.[port.id])}
                </span>
              </div>
            ))}
            {ports.outputs.map((port) => (
              <div key={`out-${port.id}`} className={`port out ${port.kind === 'text' ? 'text' : ''}`}>
                <span className="dot" />
                <span className="name">{port.label}</span>
                <span className="live" style={{ color: portColors[port.kind] }}>
                  {format(component.outputValues?.[port.id])}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Runtime</div>
      <div style={{ padding: '0 12px 10px' }}>
        {Object.entries(state)
          .filter(([, value]) => value === null || ['number', 'boolean', 'string'].includes(typeof value))
          .slice(0, 14)
          .map(([key, value]) => (
            <div className="kv" key={key}>
              <span>{key}</span>
              <span>{format(value)}</span>
            </div>
          ))}
      </div>

      {probes.length > 0 && <Scope component={component} probes={probes} tick={tick} />}

      <div className="section-title">Actions</div>
      <div style={{ padding: '0 12px 16px', display: 'grid', gap: 6 }}>
        <button className="btn" onClick={() => engine.deleteComponent(component.id)}>
          Delete component
        </button>
        <button className="btn" onClick={() => engine.simulation.world.rebuildBroadPhase()}>
          Rebuild broad phase
        </button>
      </div>
    </aside>
  )
}

/** One control row. Uncontrolled input + imperative write-back. */
function ControlRow({ control, component, engine }) {
  const value = component.properties[control.key]
  const outputRef = useRef(null)

  const commit = (next) => {
    engine.updateProperty(component, control.key, next)
    if (outputRef.current) outputRef.current.textContent = format(next)
  }

  if (control.type === 'number') {
    const decimals = (control.step ?? 1) < 1 ? 2 : 0
    return (
      <div className="row">
        <label title={control.label}>{control.label}</label>
        <input
          type="range"
          min={control.min ?? 0}
          max={control.max ?? 100}
          step={control.step ?? 1}
          defaultValue={Number(value) || 0}
          onInput={(event) => commit(Number(event.target.value))}
        />
        <span className="value" ref={outputRef} style={{ minWidth: 46, textAlign: 'right' }}>
          {Number(value).toFixed(decimals)}
        </span>
      </div>
    )
  }

  if (control.type === 'boolean') {
    return (
      <div className="row">
        <label>{control.label}</label>
        <input
          type="checkbox"
          defaultChecked={Boolean(value)}
          onChange={(event) => commit(event.target.checked)}
        />
      </div>
    )
  }

  if (control.type === 'select') {
    return (
      <div className="row">
        <label>{control.label}</label>
        <select defaultValue={String(value)} onChange={(event) => commit(event.target.value)}>
          {(control.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className="row">
      <label>{control.label}</label>
      <input
        type="text"
        defaultValue={String(value ?? '')}
        style={{ width: 150 }}
        onChange={(event) => commit(event.target.value)}
      />
    </div>
  )
}

/** Oscilloscope for this component's probes — reads the engine's ring buffers. */
function Scope({ component, probes, tick }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr
      canvas.height = height * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const simulation = component.simulation
    const rows = probes.slice(0, 3)
    rows.forEach((probe, index) => {
      const trace = simulation?.readTrace(`${component.id}:${probe.id}`)
      if (!trace || trace.length < 2) return
      const samples = trace.samples
      let min = Infinity
      let max = -Infinity
      for (const sample of samples) {
        if (sample < min) min = sample
        if (sample > max) max = sample
      }
      if (max - min < 1e-6) max = min + 1
      const rowHeight = height / rows.length
      const top = index * rowHeight
      const pad = 5

      ctx.strokeStyle = probe.color ?? '#38bdf8'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * width
        const y = top + pad + (1 - (samples[i] - min) / (max - min)) * (rowHeight - pad * 2)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      ctx.fillStyle = 'rgba(219,234,254,0.72)'
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillText(`${probe.label} ${samples[samples.length - 1].toFixed(1)}${probe.unit ?? ''}`, 6, top + 12)
    })
  }, [component, probes, tick])

  return (
    <>
      <div className="section-title">Scope</div>
      <canvas className="scope" ref={canvasRef} />
    </>
  )
}

function format(value) {
  if (typeof value === 'number') {
    const abs = Math.abs(value)
    if (abs >= 1000) return value.toFixed(0)
    if (abs >= 10) return value.toFixed(1)
    return value.toFixed(2)
  }
  if (typeof value === 'boolean') return value ? 'HIGH' : 'LOW'
  if (value === null || value === undefined) return '—'
  return String(value)
}
