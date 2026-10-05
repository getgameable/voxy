import { useEffect } from 'react'

export interface Recording {
  sequenceId: number
  url: string       // object URL — caller owns lifecycle
  durationMs: number
  createdAt: number
}

interface Props {
  recordings: Recording[]
  onClear: () => void
}

export function RecordingLog({ recordings, onClear }: Props) {
  // Revoke all object URLs when the component unmounts (page unload / hot reload)
  useEffect(() => {
    return () => {
      recordings.forEach(r => URL.revokeObjectURL(r.url))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="panel recording-log-panel">
      <div className="panel-header">
        <h2 className="panel-title">Recordings ({recordings.length})</h2>
        {recordings.length > 0 && (
          <button className="btn btn--ghost" onClick={onClear}>clear</button>
        )}
      </div>

      {recordings.length === 0 ? (
        <p className="recording-log-empty">No recordings yet — speak to capture an utterance</p>
      ) : (
        <ul className="recording-list">
          {recordings.map(r => (
            <li key={r.sequenceId} className="recording-entry">
              <span className="recording-entry__meta">
                #{r.sequenceId}
                <span className="recording-entry__dur">{(r.durationMs / 1000).toFixed(1)}s</span>
              </span>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls src={r.url} className="recording-entry__player" />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
