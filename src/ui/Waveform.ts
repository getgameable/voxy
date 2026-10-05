import type { IVoxyCore, VoxyState, VadFramePayload } from '../lib/types'

/**
 * Compact waveform renderer for the widget.
 *
 * Subscribes to `vad-frame` events on the VoxyCore instance and paints a
 * rolling history of:
 *   - mirrored amplitude bars around a centre line (green / dimmed when muted)
 *   - a thin blue line tracking Silero VAD probability
 *
 * Intentionally simpler than the dev-ui AudioMonitor — no thresholds, no grid,
 * no labels. The widget uses its border glow for state cues, so the canvas can
 * stay minimal and stay legible at 60 px wide.
 */

const HISTORY = 96  // ~3 s of audio at 32 ms / frame

interface Frame { amp: number; prob: number; gated: boolean }

const PALETTE = {
  bg:        'transparent',
  ampBase:   '#4ade80',  // green
  ampGated:  '#2e4e3a',
  ampSpeak:  '#6c8aff',  // blue when USER_SPEAKING
  ampMuted:  '#3a3a48',
  prob:      '#c0cdff',
  probMuted: '#4a4a58',
} as const

export class Waveform {
  private readonly voxy: IVoxyCore
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly frames: Frame[] = []
  private raf = 0
  private size = { w: 0, h: 0, dpr: 1 }
  private state: VoxyState = 'IDLE'
  private readonly ro: ResizeObserver
  private readonly onFrame: (p: VadFramePayload) => void

  constructor(voxy: IVoxyCore, canvas: HTMLCanvasElement) {
    this.voxy = voxy
    this.ctx  = canvas.getContext('2d')

    this.ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const dpr = window.devicePixelRatio || 1
      const { width, height } = e.contentRect
      this.size = { w: width, h: height, dpr }
      canvas.width  = Math.max(1, Math.round(width  * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      this.scheduleDraw()
    })
    this.ro.observe(canvas)

    this.onFrame = (p) => {
      this.frames.push({ amp: p.amplitude, prob: p.prob, gated: p.gated })
      if (this.frames.length > HISTORY) this.frames.shift()
      this.scheduleDraw()
    }
    this.voxy.on('vad-frame', this.onFrame)
  }

  setState(state: VoxyState): void {
    if (state === this.state) return
    this.state = state
    if (state === 'IDLE') this.frames.length = 0   // clear on stop
    this.scheduleDraw()
  }

  private scheduleDraw(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx) return
    const { w: W, h: H, dpr } = this.size
    if (W === 0 || H === 0) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const isMuted   = this.state === 'MUTED'
    const isSpeak   = this.state === 'USER_SPEAKING'
    const ampColor  = isMuted ? PALETTE.ampMuted : isSpeak ? PALETTE.ampSpeak : PALETTE.ampBase
    const gateColor = isMuted ? PALETTE.ampMuted : PALETTE.ampGated
    const probColor = isMuted ? PALETTE.probMuted : PALETTE.prob

    const mid   = H / 2
    const barW  = W / HISTORY
    const N     = this.frames.length

    // ── Amplitude bars — mirrored around the centre line ─────────────────────
    for (let i = 0; i < N; i++) {
      const f = this.frames[i]
      // RMS is typically small; amplify so casual speech fills most of the canvas.
      const h = Math.min(f.amp * H * 3, H)
      const x = (HISTORY - N + i) * barW
      ctx.fillStyle = f.gated ? gateColor : ampColor
      ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h)
    }

    // ── VAD probability line ─────────────────────────────────────────────────
    if (N > 1) {
      ctx.strokeStyle = probColor
      ctx.lineWidth   = 1.25
      ctx.beginPath()
      for (let i = 0; i < N; i++) {
        const x = (HISTORY - N + i) * barW + barW / 2
        // Flip so higher prob = higher on canvas
        const y = H - this.frames[i].prob * H
        if (i === 0) ctx.moveTo(x, y)
        else         ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  destroy(): void {
    this.voxy.off('vad-frame', this.onFrame)
    this.ro.disconnect()
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }
}
