/**
 * Status bar. Every number comes from the engine's own `stats` object, which is
 * emitted from inside the frame loop — so what is displayed here *is* what the
 * fixed-timestep accumulator is doing, not a React-side estimate.
 */
export function StatusBar({ stats, engine, ready }) {
  if (!stats) {
    return (
      <footer className="status">
        <span>{ready ? 'Engine starting…' : 'Booting'}</span>
      </footer>
    )
  }

  const fps = stats.fps ?? 60
  const fpsClass = fps >= 55 ? 'ok' : fps >= 30 ? 'warn' : 'bad'
  const budget = stats.physicsMs ?? 0
  const budgetClass = budget < 8 ? 'ok' : budget < 16 ? 'warn' : 'bad'

  return (
    <footer className="status">
      <span className={fpsClass}>{fps.toFixed(0)} fps</span>
      <span>frame {stats.frameMs?.toFixed(1)} ms</span>
      <span className={budgetClass}>physics {budget.toFixed(2)} ms</span>
      <span>Δt 1/60 s · α {stats.alpha?.toFixed(2)}</span>
      <span>bodies {stats.bodies}</span>
      <span>pairs {stats.candidatePairs}</span>
      <span>contacts {stats.contacts}</span>
      <span>fluid {stats.fluid}</span>
      <span>hash {stats.hashCells}</span>
      <span>nodes {stats.components}</span>
      <span>wires {stats.wires}</span>
      <span>steps {stats.totalSteps}</span>
      {stats.droppedSteps > 0 && <span className="warn">shed {stats.droppedSteps}</span>}
      <span className="spacer" style={{ flex: 1 }} />
      <span>{engine?.simulation.name ?? ''}</span>
      <span>{stats.running ? 'RUNNING' : 'PAUSED'}</span>
    </footer>
  )
}
