import type { IVoxyCore, StateChangePayload, MuteChangePayload, VoxyState } from '../lib/types'
import { Waveform } from './Waveform'
import { MuteButton } from './MuteButton'

const STYLE_ID = 'voxy-widget-styles'

/**
 * Widget style sheet.
 *
 * Design goals:
 *   - Mobile-first: works at 120 px (icon + tiny waveform). Grows up to 300 px.
 *   - The outer border / box-shadow is the primary state indicator: a soft glow
 *     when LISTENING or AVATAR_SPEAKING, a stronger pulse when USER_SPEAKING,
 *     and a dimmed/flat look when MUTED or IDLE.
 *   - Inline waveform lives inside the pill; state + audio amplitude are both
 *     legible at a glance without needing text.
 */
const CSS = `
.voxy-widget {
  /* NOTE: --voxy-glow-color is space-separated RGB (no commas) so it can
     be used with the modern rgb(R G B / A) slash-alpha syntax below. */
  --voxy-bg: #1e1e24;
  --voxy-glow-color: 108 138 255;
  --voxy-glow-inner: 0;               /* 0..1 intensity of tight glow */
  --voxy-glow-outer: 0;               /* 0..1 intensity of ambient halo */
  --voxy-border-color: 46 46 56;
  --voxy-border-alpha: 1;

  box-sizing: border-box;
  display: inline-grid;
  grid-template-columns: 1fr auto;
  align-items: stretch;
  gap: 0;
  width: 100%;
  min-width: 120px;
  max-width: 300px;
  height: 36px;
  padding: 4px;
  background: var(--voxy-bg);
  border: 1px solid rgb(var(--voxy-border-color) / var(--voxy-border-alpha));
  border-radius: 999px;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  color: #e4e4ef;
  transition:
    opacity 0.25s ease,
    border-color 0.25s ease,
    box-shadow 0.25s ease;
  box-shadow:
    0 0 calc(var(--voxy-glow-inner) * 10px) rgb(var(--voxy-glow-color) / calc(var(--voxy-glow-inner) * 0.7)),
    0 0 calc(var(--voxy-glow-outer) * 26px) rgb(var(--voxy-glow-color) / calc(var(--voxy-glow-outer) * 0.4));
}

.voxy-widget__canvas-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 999px 0 0 999px;
  min-width: 0;
}

.voxy-widget__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.voxy-widget__mute {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* ── Mute button ──────────────────────────────────────────────────────────── */

.voxy-mute-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid #2e2e38;
  background: #28282f;
  color: #e4e4ef;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
}

.voxy-mute-btn:hover:not(:disabled) {
  background: #32323c;
  border-color: #3a3a48;
}

.voxy-mute-btn:active:not(:disabled) { transform: scale(0.94); }

.voxy-mute-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.voxy-mute-btn__icon { width: 16px; height: 16px; }

.voxy-mute-btn--muted {
  background: #3a1a1a;
  border-color: #f87171;
  color: #f87171;
}

/* ── State-driven glow ───────────────────────────────────────────────────── */

.voxy-widget[data-state="IDLE"] {
  opacity: 0.85;
}

.voxy-widget[data-state="LISTENING"] {
  --voxy-glow-color: 74 222 128;         /* green */
  --voxy-border-color: 74 222 128;
  --voxy-border-alpha: 0.6;
  --voxy-glow-inner: 0.55;
  --voxy-glow-outer: 0.45;
}

.voxy-widget[data-state="AVATAR_SPEAKING"] {
  --voxy-glow-color: 251 146 60;         /* orange */
  --voxy-border-color: 251 146 60;
  --voxy-border-alpha: 0.6;
  --voxy-glow-inner: 0.5;
  --voxy-glow-outer: 0.4;
}

.voxy-widget[data-state="USER_SPEAKING"] {
  --voxy-glow-color: 108 138 255;        /* accent blue */
  --voxy-border-color: 108 138 255;
  --voxy-border-alpha: 0.9;
  animation: voxy-pulse 0.9s ease-in-out infinite;
}

.voxy-widget[data-state="MUTED"] {
  opacity: 0.45;
  filter: grayscale(0.6);
}

@keyframes voxy-pulse {
  0%, 100% {
    --voxy-glow-inner: 0.55;
    --voxy-glow-outer: 0.45;
  }
  50% {
    --voxy-glow-inner: 0.95;
    --voxy-glow-outer: 0.8;
  }
}

/* @property makes the custom-property values animatable smoothly rather than
   jumping between keyframe steps. Falls back gracefully in older browsers
   (they just get the default 0/100% values, no smooth interpolation). */
@property --voxy-glow-inner {
  syntax: '<number>';
  initial-value: 0;
  inherits: false;
}
@property --voxy-glow-outer {
  syntax: '<number>';
  initial-value: 0;
  inherits: false;
}

@media (prefers-reduced-motion: reduce) {
  .voxy-widget[data-state="USER_SPEAKING"] {
    animation: none;
    --voxy-glow-inner: 0.75;
    --voxy-glow-outer: 0.6;
  }
}
`

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

export class VoxyWidget {
  private readonly voxy: IVoxyCore
  private readonly container: HTMLElement
  private readonly widget: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly muteEl: HTMLDivElement
  private readonly waveform: Waveform
  private readonly muteBtn: MuteButton
  private unsubscribers: (() => void)[] = []

  constructor(voxy: IVoxyCore, container: HTMLElement | string) {
    this.voxy = voxy
    if (typeof container === 'string') {
      const el = document.querySelector<HTMLElement>(container)
      if (!el) throw new Error(`VoxyWidget: container "${container}" not found`)
      this.container = el
    } else {
      this.container = container
    }

    injectStyles()

    this.widget = document.createElement('div')
    this.widget.className = 'voxy-widget'
    this.widget.dataset.state = 'IDLE'

    const canvasWrap = document.createElement('div')
    canvasWrap.className = 'voxy-widget__canvas-wrap'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'voxy-widget__canvas'
    canvasWrap.appendChild(this.canvas)

    this.muteEl = document.createElement('div')
    this.muteEl.className = 'voxy-widget__mute'

    this.widget.appendChild(canvasWrap)
    this.widget.appendChild(this.muteEl)
    this.container.appendChild(this.widget)

    this.waveform = new Waveform(this.voxy, this.canvas)
    this.muteBtn  = new MuteButton(this.muteEl, () => this._onMuteClick())

    this._syncState()
    this._subscribe()
  }

  private _onMuteClick(): void {
    if (this.voxy.getState() === 'MUTED') this.voxy.unmute()
    else                                  this.voxy.mute()
  }

  private _syncState(): void {
    const state: VoxyState = this.voxy.getState()
    const isIdle = !this.voxy.isStarted()
    this.widget.dataset.state = state
    this.waveform.setState(state)
    this.muteBtn.update(state === 'MUTED', isIdle)
  }

  private _subscribe(): void {
    const onStateChange = (_p: StateChangePayload) => this._syncState()
    const onMuteChange  = (_p: MuteChangePayload)  => this._syncState()

    this.voxy.on('state-change', onStateChange)
    this.voxy.on('mute-change',  onMuteChange)

    this.unsubscribers.push(
      () => this.voxy.off('state-change', onStateChange),
      () => this.voxy.off('mute-change',  onMuteChange),
    )
  }

  destroy(): void {
    this.unsubscribers.forEach(fn => fn())
    this.unsubscribers = []
    this.waveform.destroy()
    this.muteBtn.destroy()
    this.container.removeChild(this.widget)
  }
}
