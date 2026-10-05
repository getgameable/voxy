import { useEffect, useRef, useState } from 'react'

interface Props {
  onApply: (rmsStart: number, rmsEnd: number) => void
}

type Phase = 'idle' | 'calibrating' | 'done' | 'error'

const DURATION_MS   = 5_000
const INTERVAL_MS   = 100
const TOTAL_SAMPLES = DURATION_MS / INTERVAL_MS // 50
const FFT_SIZE      = 2048

// Multipliers applied to the p95 noise floor to derive thresholds
const START_MULT = 3.0
const END_MULT   = 1.5

interface Result {
  noiseFloor: number
  suggestedStart: number
  suggestedEnd: number
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function NoiseCalibrator({ onApply }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)         // 0–100
  const [secondsLeft, setSecondsLeft] = useState(5)
  const [result, setResult] = useState<Result | null>(null)

  // Holds cleanup fn so we can cancel on unmount
  const cleanupRef = useRef<() => void>(() => {})
  useEffect(() => () => cleanupRef.current(), [])

  async function startCalibration() {
    setPhase('calibrating')
    setProgress(0)
    setSecondsLeft(5)
    setResult(null)

    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let intervalId: ReturnType<typeof setInterval> | null = null

    function cleanup() {
      if (intervalId !== null) clearInterval(intervalId)
      stream?.getTracks().forEach(t => t.stop())
      ctx?.close().catch(() => {})
      stream = null
      ctx = null
      intervalId = null
    }
    cleanupRef.current = cleanup

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      cleanup()
      setPhase('error')
      return
    }

    ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    source.connect(analyser)

    const buf = new Float32Array(analyser.fftSize)
    const samples: number[] = []
    let count = 0

    intervalId = setInterval(() => {
      analyser.getFloatTimeDomainData(buf)

      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      samples.push(Math.sqrt(sum / buf.length))
      count++

      setProgress(count / TOTAL_SAMPLES * 100)
      setSecondsLeft(Math.max(0, Math.ceil((TOTAL_SAMPLES - count) * INTERVAL_MS / 1000)))

      if (count >= TOTAL_SAMPLES) {
        cleanup()

        const noiseFloor     = p95(samples)
        const suggestedStart = round3(noiseFloor * START_MULT)
        const suggestedEnd   = round3(noiseFloor * END_MULT)

        setResult({ noiseFloor, suggestedStart, suggestedEnd })
        setPhase('done')
      }
    }, INTERVAL_MS)
  }

  if (phase === 'idle') {
    return (
      <button className="btn calibrate-btn" onClick={startCalibration}>
        Calibrate noise floor
      </button>
    )
  }

  if (phase === 'error') {
    return (
      <div className="calibrator">
        <span className="calibrator__error">Mic access denied</span>
        <button className="btn btn--ghost" onClick={() => setPhase('idle')}>Dismiss</button>
      </div>
    )
  }

  if (phase === 'calibrating') {
    return (
      <div className="calibrator">
        <div className="calibrator__header">
          <span className="calibrator__label">Stay silent — measuring…</span>
          <span className="calibrator__countdown">{secondsLeft}s</span>
        </div>
        <div className="calibrator__track">
          <div className="calibrator__bar" style={{ width: `${progress}%` }} />
        </div>
      </div>
    )
  }

  // done
  const { noiseFloor, suggestedStart, suggestedEnd } = result!
  return (
    <div className="calibrator calibrator--done">
      <div className="calibrator__readings">
        <span className="calibrator__reading">
          <span className="calibrator__reading-label">Floor</span>
          <span className="calibrator__reading-value">{noiseFloor.toFixed(4)}</span>
        </span>
        <span className="calibrator__arrow">→</span>
        <span className="calibrator__reading">
          <span className="calibrator__reading-label">Start</span>
          <span className="calibrator__reading-value">{suggestedStart.toFixed(3)}</span>
        </span>
        <span className="calibrator__reading">
          <span className="calibrator__reading-label">End</span>
          <span className="calibrator__reading-value">{suggestedEnd.toFixed(3)}</span>
        </span>
      </div>
      <div className="button-row">
        <button
          className="btn btn--primary"
          onClick={() => {
            onApply(suggestedStart, suggestedEnd)
            setPhase('idle')
            setResult(null)
          }}
        >
          Apply
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => { setPhase('idle'); setResult(null) }}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
