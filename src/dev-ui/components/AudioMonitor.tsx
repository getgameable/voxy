import { useEffect, useRef } from 'react'
import type { VoxyCore } from '@lib'

interface Props {
  voxy: VoxyCore
}

// How many frames to keep in the rolling buffer (~10 s at 32 ms/frame).
const HISTORY = 300

// Canvas colours — match the dark theme palette.
const C_BG           = '#0d0d0f'
const C_GRID         = '#2e2e38'
const C_AMP          = '#3a7a4a'
const C_PROB         = '#6c8aff'
const C_THRESH_START = 'rgba(108,138,255,0.55)'
const C_THRESH_END   = 'rgba(255,160,80,0.55)'
const C_LABEL        = '#7070a0'
const C_NOISE_FLOOR  = 'rgba(255,100,100,0.55)'
const C_AMP_GATED    = '#2a3a2a'

interface Frame { prob: number; amplitude: number; noiseFloor: number; gated: boolean }

export function AudioMonitor({ voxy }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const framesRef = useRef<Frame[]>([])
  const rafRef    = useRef<number>(0)
  // Cached canvas dimensions — updated by ResizeObserver, not on every draw.
  const sizeRef   = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // Keep canvas backing-store resolution matched to its CSS size via ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      canvas.width  = width
      canvas.height = height
      sizeRef.current = { w: width, h: height }
      scheduleDraw()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  function scheduleDraw() {
    // Only schedule one pending RAF at a time.
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawCanvas()
    })
  }

  function drawCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { w: W, h: H } = sizeRef.current
    if (W === 0 || H === 0) return

    const frames = framesRef.current
    const N      = frames.length
    const tStart = voxy.config.vadThreshold
    const tEnd   = voxy.config.vadEndThreshold

    // ── Background ─────────────────────────────────────────────────────────
    ctx.fillStyle = C_BG
    ctx.fillRect(0, 0, W, H)

    // ── Grid lines (0.25, 0.5, 0.75) ───────────────────────────────────────
    ctx.strokeStyle = C_GRID
    ctx.lineWidth   = 1
    for (const v of [0.25, 0.5, 0.75]) {
      const y = Math.round(H - v * H) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
    }

    if (N === 0) return

    const barW = W / HISTORY

    // ── Amplitude bars (dimmed when energy-gated) ─────────────────────────
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = frames[i].gated ? C_AMP_GATED : C_AMP
      const x = (HISTORY - N + i) * barW
      const h = Math.min(frames[i].amplitude * H * 3, H) // RMS is ~⅓ of peak, scale up
      ctx.fillRect(x, H - h, barW - 0.5, h)
    }

    // ── Probability line ────────────────────────────────────────────────────
    ctx.strokeStyle = C_PROB
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const x = (HISTORY - N + i) * barW + barW / 2
      const y = H - frames[i].prob * H
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()

    // ── Threshold lines ─────────────────────────────────────────────────────
    const drawThreshold = (value: number, color: string, label: string) => {
      const y = Math.round(H - value * H) + 0.5
      ctx.strokeStyle = color
      ctx.lineWidth   = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.font      = '9px monospace'
      ctx.fillText(`${label} ${value.toFixed(2)}`, 4, y - 3)
    }

    drawThreshold(tStart, C_THRESH_START, 'start')
    drawThreshold(tEnd,   C_THRESH_END,   'end')

    // ── Noise floor gate line ──────────────────────────────────────────────
    // The gate threshold (noiseFloor × gateMult) is an RMS value — typically
    // very small (0.001–0.02).  Amplitude bars use a ×3 scale, but that
    // still leaves the gate line barely visible.  We use a higher fixed scale
    // (×30) so the line sits at a visible height and clearly responds to
    // multiplier changes.  This matches the "zoomed-in" lower portion of the
    // amplitude display where noise-vs-speech decisions actually matter.
    const lastFloor = frames[N - 1].noiseFloor
    if (lastFloor > 0) {
      const gateMult  = voxy.config.energyGateMult
      const gateRms   = lastFloor * gateMult
      const gateScale = 30  // amplified scale for visibility
      const gateY     = Math.round(H - Math.min(gateRms * gateScale, 0.8) * H) + 0.5

      ctx.strokeStyle = C_NOISE_FLOOR
      ctx.lineWidth   = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(0, gateY)
      ctx.lineTo(W, gateY)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = C_NOISE_FLOOR
      ctx.font      = '9px monospace'
      ctx.fillText(`gate ${gateRms.toFixed(4)}`, 4, gateY - 3)
    }

    // ── Corner labels ───────────────────────────────────────────────────────
    ctx.font      = '9px monospace'
    ctx.fillStyle = C_LABEL
    ctx.fillText('PROB', 4, 11)
    ctx.fillStyle = C_AMP
    ctx.fillText('AMP×3', W - 44, 11)
  }

  // Subscribe to vad-frame events — draw is triggered only when new data arrives.
  useEffect(() => {
    const handler = ({ prob, amplitude, noiseFloor, gated }: { prob: number; amplitude: number; noiseFloor: number; gated: boolean }) => {
      const buf = framesRef.current
      buf.push({ prob, amplitude, noiseFloor, gated })
      if (buf.length > HISTORY) buf.shift()
      scheduleDraw()
    }
    voxy.on('vad-frame', handler)
    return () => {
      voxy.off('vad-frame', handler)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [voxy])

  return (
    <section className="panel audio-monitor-panel">
      <div className="panel-header">
        <h2 className="panel-title">Audio Monitor</h2>
      </div>
      <canvas ref={canvasRef} className="audio-monitor-canvas" />
    </section>
  )
}
