import type { VoxyState, StateChangePayload } from '@types'
import { STATES, STATE_LABELS, STATE_DESCRIPTIONS } from '@lib/domain/state-machine'

interface Props {
  state: VoxyState
  lastTransition: StateChangePayload | null
}

export function StateMachineViz({ state, lastTransition }: Props) {
  return (
    <section className="panel state-machine-panel">
      <h2 className="panel-title">State Machine</h2>
      <div className="state-nodes">
        {STATES.map(s => (
          <div
            key={s}
            className={`state-node state-node--${s.toLowerCase().replace('_', '-')} ${state === s ? 'state-node--active' : ''}`}
          >
            <span className="state-node__dot" />
            <span className="state-node__label">{STATE_LABELS[s]}</span>
            {STATE_DESCRIPTIONS[s] && (
              <span className="state-node__desc">{STATE_DESCRIPTIONS[s]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="last-transition">
        {lastTransition ? (
          <>
            <span className="last-transition__label">Last transition</span>
            <span className="last-transition__value">
              {lastTransition.from ?? 'null'} → {lastTransition.to}
            </span>
          </>
        ) : (
          <span className="last-transition__label">No transitions yet</span>
        )}
      </div>
    </section>
  )
}
