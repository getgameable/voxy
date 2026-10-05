import { useEffect, useRef, useState } from 'react'

export interface LogEntry {
  id: number
  timestamp: string
  event: string
  payload: Record<string, unknown>
}

interface Props {
  events: LogEntry[]
  onClear: () => void
}

// Events hidden by default — too noisy for normal use
const DEBUG_EVENTS = new Set(['audio-chunk'])

const EVENT_COLORS: Record<string, string> = {
  'state-change': 'event--state-change',
  'barge-in':     'event--barge-in',
  'speech-start': 'event--speech-start',
  'speech-end':   'event--speech-end',
  'audio-chunk':  'event--audio-chunk',
  'mute-change':  'event--mute-change',
  'text-submit':  'event--text-submit',
  'warn':         'event--warn',
  'error':        'event--error',
}

function formatPayload(event: string, payload: Record<string, unknown>): string {
  if (event === 'audio-chunk') {
    const { chunk, timestamp, sequenceId } = payload as { chunk: ArrayBuffer; timestamp: number; sequenceId: number }
    return `seq=${sequenceId}  ${chunk instanceof ArrayBuffer ? chunk.byteLength : 0}B  t=${timestamp}`
  }
  const entries = Object.entries(payload)
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')
}

export function EventLog({ events, onClear }: Props) {
  const [showDebug, setShowDebug] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const visible = showDebug ? events : events.filter(e => !DEBUG_EVENTS.has(e.event))
  const hiddenCount = events.length - visible.length

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visible.length])

  return (
    <section className="panel event-log-panel">
      <div className="panel-header">
        <h2 className="panel-title">Event Log</h2>
        <span className="event-count">{events.length} events</span>
        <button
          className={`btn btn--ghost log-level-toggle ${showDebug ? 'log-level-toggle--active' : ''}`}
          onClick={() => setShowDebug(s => !s)}
          title="Toggle debug events (audio-chunk)"
        >
          debug {hiddenCount > 0 && !showDebug ? `(+${hiddenCount})` : ''}
        </button>
        <button className="btn btn--ghost" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="event-log-body">
        {visible.length === 0 && (
          <div className="event-log-empty">
            {events.length === 0 ? 'No events yet — click Start' : 'No events at this log level'}
          </div>
        )}
        {visible.map(entry => (
          <div key={entry.id} className={`event-row ${EVENT_COLORS[entry.event] ?? ''}`}>
            <span className="event-row__ts">{entry.timestamp}</span>
            <span className="event-row__name">{entry.event}</span>
            <span className="event-row__payload">{formatPayload(entry.event, entry.payload)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}
