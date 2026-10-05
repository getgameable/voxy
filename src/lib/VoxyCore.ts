import type { VoxyEventMap, VoxyState, IVoxyCore, VoxyConfig, VadFramePayload } from './types'
import { DEFAULT_CONFIG } from './types'
import { EventEmitter } from './EventEmitter'
import { StateMachine } from './StateMachine'
import { AudioPipeline, MicError } from './AudioPipeline'
import type { WorkletMessage } from './AudioPipeline'
import { encodeWav } from './utils/wavEncode'

export class VoxyCore extends EventEmitter<VoxyEventMap> implements IVoxyCore {
  private sm = new StateMachine()
  private pipeline: AudioPipeline
  private started = false
  private stopped = false   // set by stop(); prevents a pending start() from completing
  private sequenceId = 0
  private speechStartTime: number | null = null
  private speechChunks: ArrayBuffer[] = []
  readonly config: VoxyConfig

  constructor(config: Partial<VoxyConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.pipeline = new AudioPipeline(
      {
        sampleRate:        this.config.sampleRate,
        silenceTimeoutMs:  this.config.silenceTimeoutMs,
        vadThreshold:      this.config.vadThreshold,
        vadEndThreshold:   this.config.vadEndThreshold,
        preRollMs:         this.config.preRollMs,
        minSpeechMs:       this.config.minSpeechMs,
        modelUrl:          this.config.modelUrl,
        noiseSuppression:     this.config.noiseSuppression,
        noiseSuppressionUrl:  this.config.noiseSuppressionUrl,
        energyGateEnabled: this.config.energyGateEnabled,
        energyGateMult:    this.config.energyGateMult,
        noiseAdaptRate:    this.config.noiseAdaptRate,
        calibrationMs:     this.config.calibrationMs,
      },
      (msg) => this._onWorkletMessage(msg),
      (code, message) => this.emit('warn', { code, message }),
      (prob, amplitude, noiseFloor, gated) => this.emit('vad-frame', { prob, amplitude, noiseFloor, gated } satisfies VadFramePayload),
    )
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log('[VoxyCore] start() called, already started:', this.started)
    if (this.started || this.stopped) return
    try {
      console.log('[VoxyCore] calling pipeline.start()...')
      await this.pipeline.start()
      // stop() may have been called while awaiting the pipeline
      if (this.stopped) {
        console.log('[VoxyCore] stop() was called during pipeline.start() — aborting')
        this.pipeline.stop()
        return
      }
      console.log('[VoxyCore] pipeline.start() succeeded')
    } catch (err) {
      console.error('[VoxyCore] pipeline.start() threw:', err)
      if (err instanceof MicError) {
        this.emit('error', { code: err.code, message: err.message })
        return
      }
      this.emit('error', { code: 'AUDIO_CONTEXT_FAILED', message: String(err) })
      return
    }
    this.started = true
    console.log('[VoxyCore] transitioning to LISTENING')
    this._transition('LISTENING')
  }

  stop(): void {
    this.stopped = true
    if (!this.started) return
    this.pipeline.stop()
    this.started = false
    this.speechStartTime = null
    this._transition('IDLE')
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  mute(): void {
    if (!this.started || this.sm.getState() === 'MUTED') return
    this.pipeline.setInputEnabled(false)
    this._transition('MUTED')
    this.emit('mute-change', { muted: true })
  }

  unmute(): void {
    if (this.sm.getState() !== 'MUTED') return
    this.pipeline.setInputEnabled(true)
    this._transition('LISTENING')
    this.emit('mute-change', { muted: false })
  }

  // ── Avatar signalling ──────────────────────────────────────────────────────

  avatarSpeaking(): void {
    if (this.sm.getState() !== 'LISTENING') return
    this._transition('AVATAR_SPEAKING')
  }

  avatarIdle(): void {
    if (this.sm.getState() !== 'AVATAR_SPEAKING') return
    this._transition('LISTENING')
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getState(): VoxyState { return this.sm.getState() }
  isStarted(): boolean  { return this.started }

  /** Push updated VAD thresholds/silence timeout to the running engine. Safe to call at any time. */
  updateVadConfig(config: { vadThreshold?: number; vadEndThreshold?: number; silenceTimeoutMs?: number; minSpeechMs?: number; energyGateEnabled?: boolean; energyGateMult?: number; noiseAdaptRate?: number }): void {
    if (config.vadThreshold    != null) this.config.vadThreshold    = config.vadThreshold
    if (config.vadEndThreshold != null) this.config.vadEndThreshold = config.vadEndThreshold
    if (config.silenceTimeoutMs != null) this.config.silenceTimeoutMs = config.silenceTimeoutMs
    if (config.minSpeechMs     != null) this.config.minSpeechMs     = config.minSpeechMs
    if (config.energyGateEnabled != null) this.config.energyGateEnabled = config.energyGateEnabled
    if (config.energyGateMult   != null) this.config.energyGateMult   = config.energyGateMult
    if (config.noiseAdaptRate   != null) this.config.noiseAdaptRate   = config.noiseAdaptRate
    this.pipeline.updateConfig(config)
  }

  /** Force re-calibration of the noise floor estimate (e.g. after changing rooms or audio devices). */
  resetNoiseFloor(): void {
    this.pipeline.resetNoiseFloor()
  }

  // ── Worklet message handler ────────────────────────────────────────────────

  private _onWorkletMessage(msg: WorkletMessage): void {
    switch (msg.type) {
      case 'speech-start': {
        const state = this.sm.getState()
        if (state === 'MUTED' || state === 'IDLE') return

        this.sequenceId++
        this.speechStartTime = Date.now()
        this.speechChunks = []

        if (state === 'AVATAR_SPEAKING') {
          this.emit('barge-in', { sequenceId: this.sequenceId })
        }

        this._transition('USER_SPEAKING')
        this.emit('speech-start', { sequenceId: this.sequenceId })
        break
      }

      case 'audio-chunk': {
        if (this.sm.getState() !== 'USER_SPEAKING') return
        // Store for utterance assembly (pre-roll and live chunks both land here)
        this.speechChunks.push(msg.chunk)
        this.emit('audio-chunk', {
          chunk:      msg.chunk,
          timestamp:  Date.now(),
          sequenceId: this.sequenceId,
        })
        break
      }

      case 'speech-end': {
        if (this.sm.getState() !== 'USER_SPEAKING') return
        const durationMs = this.speechStartTime ? Date.now() - this.speechStartTime : 0
        this.speechStartTime = null
        const seq = this.sequenceId

        // Encode the full utterance (pre-roll + live chunks) and emit before
        // the state-change so listeners can correlate by sequenceId.
        if (this.speechChunks.length > 0) {
          const audio = encodeWav(this.speechChunks, this.config.sampleRate)
          this.speechChunks = []
          this.emit('utterance-audio', { audio, sequenceId: seq, durationMs })
        }

        this._transition('LISTENING')
        this.emit('speech-end', { durationMs, sequenceId: seq })
        break
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _transition(to: VoxyState): void {
    const from = this.sm.transition(to)
    if (from !== null) this.emit('state-change', { from, to })
  }
}
