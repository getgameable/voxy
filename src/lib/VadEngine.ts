/**
 * VadEngine — main-thread coordinator for voice activity detection.
 *
 * Responsibilities:
 *   - Receives raw PCM frames (512 samples, Float32) from the AudioWorklet
 *   - Forwards frames to the VadWorker for Silero ONNX inference
 *   - Falls back to RMS energy detection if the worker fails to initialise
 *   - Maintains a pre-roll circular buffer so sentence starts are never clipped
 *   - Applies start/end hysteresis and maps results to WorkletMessage callbacks
 *     (speech-start, audio-chunk, speech-end) — the same shapes VoxyCore expects
 */

import VadWorkerClass from './workers/vad-worker?worker'
import type { WorkletMessage } from './AudioPipeline'

export interface VadEngineConfig {
  modelUrl: string
  vadThreshold: number      // probability to trigger speech-start (default 0.5)
  vadEndThreshold: number   // probability below which silence is counted (default 0.35)
  preRollMs: number         // audio retained before speech trigger (default 500)
  silenceTimeoutMs: number  // consecutive silence before speech-end (default 800)
  minSpeechMs: number       // consecutive VAD-active ms required before speech-start fires (default 0)
  energyGateEnabled: boolean
  energyGateMult: number
  noiseAdaptRate: number
  calibrationMs: number
}

const FRAME_SIZE    = 512
const SAMPLE_RATE   = 16_000
const MS_PER_FRAME  = (FRAME_SIZE / SAMPLE_RATE) * 1_000 // 32 ms

// The pre-roll buffer is sized to at least this multiple of the onset window
// so that words spoken before the VAD trigger are captured even when
// the utterance is short and dips below the end threshold quickly.
const PRE_ROLL_ONSET_MULTIPLIER = 3

// Fixed RMS thresholds used only in fallback mode — independent of vadThreshold scale.
const FALLBACK_RMS_START = 0.02
const FALLBACK_RMS_END   = 0.01

export class VadEngine {
  // ── Worker ──────────────────────────────────────────────────────────────────
  private worker: Worker | null = null
  private workerReady = false
  private fallbackMode = false

  // ── Inference queue ─────────────────────────────────────────────────────────
  // One inference in-flight at a time; pending frames are queued in order.
  private inferenceInFlight = false
  private inFlightFrame: Float32Array | null = null
  private pendingFrames: Float32Array[] = []

  // ── Pre-roll ─────────────────────────────────────────────────────────────────
  private readonly preRoll: Float32Array[] = []
  // Sized to max(preRollMs, minSpeechMs) so the buffer always spans the full
  // onset window — ensuring audio from onset frame 0 is available when speech confirms.
  private preRollCount: number

  // ── VAD state ────────────────────────────────────────────────────────────────
  private speaking = false
  private silentFrames = 0
  private silenceLimit: number
  private vadThreshold: number
  private vadEndThreshold: number

  // ── Onset detection ──────────────────────────────────────────────────────────
  // Frames above threshold accumulate here until minSpeechMs is satisfied.
  // If the signal drops below vadEndThreshold before that, onset is cancelled.
  private onsetFrames = 0
  private onsetLimit: number          // frames required (0 = immediate trigger)
  private onsetBuffer: Float32Array[] = []
  private preOnsetRoll: Float32Array[] = []  // preRoll snapshot taken at onset start

  // ── Energy gate / noise floor ─────────────────────────────────────────────────
  private noiseFloorRms = 0
  private calibrationCount = 0
  private calibrationLimit: number
  private calibrated = false
  private energyGateEnabled: boolean
  private energyGateMult: number
  private noiseAdaptRate: number

  // ── Config ───────────────────────────────────────────────────────────────────
  private modelUrl: string

  // ── Callbacks ────────────────────────────────────────────────────────────────
  private readonly onMessage: (msg: WorkletMessage) => void
  private readonly onWarn: (code: string, message: string) => void
  private readonly onFrame: ((prob: number, amplitude: number, noiseFloor: number, gated: boolean) => void) | undefined

  constructor(
    config: VadEngineConfig,
    onMessage: (msg: WorkletMessage) => void,
    onWarn: (code: string, message: string) => void,
    onFrame?: (prob: number, amplitude: number, noiseFloor: number, gated: boolean) => void,
  ) {
    this.modelUrl        = config.modelUrl
    this.vadThreshold    = config.vadThreshold
    this.vadEndThreshold = config.vadEndThreshold
    this.onsetLimit      = Math.ceil(config.minSpeechMs / MS_PER_FRAME)
    // Size the pre-roll to at least PRE_ROLL_ONSET_MULTIPLIER × the onset window.
    // This ensures words spoken before the VAD trigger are retained even for
    // short utterances that dip below the end threshold quickly.
    this.preRollCount    = Math.max(
      Math.ceil(config.preRollMs / MS_PER_FRAME),
      this.onsetLimit * PRE_ROLL_ONSET_MULTIPLIER,
    )
    this.silenceLimit    = Math.ceil(config.silenceTimeoutMs / MS_PER_FRAME)
    this.energyGateEnabled = config.energyGateEnabled
    this.energyGateMult    = config.energyGateMult
    this.noiseAdaptRate    = config.noiseAdaptRate
    this.calibrationLimit  = Math.ceil(config.calibrationMs / MS_PER_FRAME)
    this.onMessage       = onMessage
    this.onWarn          = onWarn
    this.onFrame         = onFrame
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  start(): void {
    try {
      this.worker = new VadWorkerClass()
      this.worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e)
      this.worker.onerror = (e: ErrorEvent) => {
        this.onWarn('VAD_FALLBACK', `Worker error: ${e.message}`)
        this.activateFallback()
      }
      this.worker.postMessage({ type: 'init', modelUrl: this.modelUrl })
    } catch (err) {
      this.onWarn('VAD_FALLBACK', `Failed to construct VAD worker: ${String(err)}`)
      this.activateFallback()
    }
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.workerReady = false
    this.inferenceInFlight = false
    this.inFlightFrame = null
    this.pendingFrames = []
    this.preRoll.length = 0
    this.speaking = false
    this.silentFrames = 0
    this.onsetFrames = 0
    this.onsetBuffer = []
    this.preOnsetRoll = []
    this.fallbackMode = false
    this.noiseFloorRms = 0
    this.calibrationCount = 0
    this.calibrated = false
  }

  // ── Frame processing ─────────────────────────────────────────────────────────

  processFrame(frame: Float32Array): void {
    // Always keep a fresh copy — the original ArrayBuffer may be detached
    // by the time we need it for pre-roll or inference.
    const copy = frame.slice(0)

    // Update pre-roll ring buffer (always, regardless of speech state)
    this.preRoll.push(copy)
    if (this.preRoll.length > this.preRollCount) this.preRoll.shift()

    if (this.fallbackMode) {
      const prob = this.rmsProb(copy)
      this.applyVad(copy, prob)
      return
    }

    if (this.workerReady && !this.inferenceInFlight) {
      this.sendToWorker(copy)
    } else {
      this.pendingFrames.push(copy)
    }
  }

  // ── Config update ────────────────────────────────────────────────────────────

  updateConfig(partial: { vadThreshold?: number; vadEndThreshold?: number; silenceTimeoutMs?: number; minSpeechMs?: number; energyGateEnabled?: boolean; energyGateMult?: number; noiseAdaptRate?: number }): void {
    if (partial.vadThreshold    != null) this.vadThreshold    = partial.vadThreshold
    if (partial.vadEndThreshold != null) this.vadEndThreshold = partial.vadEndThreshold
    if (partial.silenceTimeoutMs != null) {
      this.silenceLimit = Math.ceil(partial.silenceTimeoutMs / MS_PER_FRAME)
    }
    if (partial.minSpeechMs != null) {
      this.onsetLimit = Math.ceil(partial.minSpeechMs / MS_PER_FRAME)
      // Expand pre-roll if the new onset window × multiplier exceeds the current buffer.
      const needed = this.onsetLimit * PRE_ROLL_ONSET_MULTIPLIER
      if (needed > this.preRollCount) this.preRollCount = needed
    }
    if (partial.energyGateEnabled != null) this.energyGateEnabled = partial.energyGateEnabled
    if (partial.energyGateMult   != null) this.energyGateMult   = partial.energyGateMult
    if (partial.noiseAdaptRate   != null) this.noiseAdaptRate   = partial.noiseAdaptRate
  }

  /** Force re-calibration of the noise floor (e.g. after changing rooms or audio devices). */
  resetNoiseFloor(): void {
    this.noiseFloorRms = 0
    this.calibrationCount = 0
    this.calibrated = false
  }

  // ── Worker messaging ─────────────────────────────────────────────────────────

  private sendToWorker(frame: Float32Array): void {
    // Transfer the backing ArrayBuffer — zero-copy send to worker.
    // We keep the frame reference in inFlightFrame for applyVad when prob returns.
    const transferable = frame.buffer.slice(0) // fresh copy for transfer
    this.inferenceInFlight = true
    this.inFlightFrame = frame
    this.worker!.postMessage({ type: 'frame', samples: transferable }, [transferable])
  }

  private drainPending(): void {
    if (this.pendingFrames.length === 0) return
    const next = this.pendingFrames.shift()!
    this.sendToWorker(next)
  }

  private handleWorkerMessage(e: MessageEvent): void {
    const msg = e.data as { type: string; value?: number; message?: string; during?: string }

    switch (msg.type) {
      case 'ready':
        this.workerReady = true
        this.drainPending()
        break

      case 'prob': {
        const frame = this.inFlightFrame!
        this.inferenceInFlight = false
        this.inFlightFrame = null
        this.applyVad(frame, msg.value!)
        this.drainPending()
        break
      }

      case 'error':
        if (msg.during === 'init') {
          this.onWarn('VAD_FALLBACK', `Silero model failed to load: ${msg.message ?? ''}`)
          this.activateFallback()
        } else {
          // Single inference error — warn but stay in normal mode
          this.onWarn('VAD_INFERENCE_ERROR', msg.message ?? 'Unknown inference error')
          // Still need to drain the queue
          this.inferenceInFlight = false
          this.inFlightFrame = null
          this.drainPending()
        }
        break
    }
  }

  // ── RMS / energy gate helpers ─────────────────────────────────────────────────

  private computeRms(frame: Float32Array): number {
    let sum = 0
    for (const s of frame) sum += s * s
    return Math.sqrt(sum / frame.length)
  }

  /** Update the adaptive noise floor estimate. Only adapts on noise-like frames. */
  private updateNoiseFloor(frameRms: number, prob: number): void {
    if (!this.calibrated) {
      // During calibration, only accumulate frames that are clearly not speech
      // to avoid contaminating the noise floor if the user speaks immediately.
      if (prob < 0.3) {
        this.calibrationCount++
        // Incremental mean: avoids storing all samples
        this.noiseFloorRms += (frameRms - this.noiseFloorRms) / this.calibrationCount
      }
      if (this.calibrationCount >= this.calibrationLimit) {
        this.calibrated = true
      }
      return
    }

    // Post-calibration: slowly adapt on noise-like frames (below the gate threshold).
    if (frameRms < this.noiseFloorRms * this.energyGateMult) {
      this.noiseFloorRms = this.noiseFloorRms * (1 - this.noiseAdaptRate) + frameRms * this.noiseAdaptRate
    }
  }

  /** If the frame energy is indistinguishable from the noise floor, suppress VAD probability. */
  private energyGate(frameRms: number): boolean {
    if (!this.energyGateEnabled || !this.calibrated) return false
    return frameRms < this.noiseFloorRms * this.energyGateMult
  }

  // ── VAD decision logic ───────────────────────────────────────────────────────

  private applyVad(frame: Float32Array, prob: number): void {
    const frameRms = this.computeRms(frame)
    this.updateNoiseFloor(frameRms, prob)
    const gated = this.energyGate(frameRms)
    if (gated) prob = 0

    if (this.onFrame) {
      this.onFrame(prob, frameRms, this.noiseFloorRms, gated)
    }

    if (!this.speaking) {
      if (prob >= this.vadThreshold || this.onsetFrames > 0) {
        // Either the first crossing or a continuation of the onset window.
        if (prob < this.vadEndThreshold) {
          // Signal dropped during onset — cancel and wait for next crossing.
          this.onsetFrames = 0
          this.onsetBuffer = []
          this.preOnsetRoll = []
          return
        }

        if (this.onsetFrames === 0) {
          // First frame above threshold: snapshot preRoll before onset begins.
          // In async inference mode, pendingFrames.length frames have already been
          // pushed to preRoll after F0 was sent to the worker.  Exclude all of
          // those plus F0 itself so the snapshot ends at the frame just before F0.
          const offset = this.pendingFrames.length + 1
          this.preOnsetRoll = this.preRoll.slice(0, -offset)
        }

        this.onsetBuffer.push(frame)
        this.onsetFrames++

        if (this.onsetFrames >= Math.max(1, this.onsetLimit)) {
          // Onset confirmed — enough consecutive speech frames accumulated.
          this.speaking = true
          this.silentFrames = 0
          // Emit speech-start first so VoxyCore resets its chunk accumulator.
          this.onMessage({ type: 'speech-start' })
          // Flush pre-onset audio then the onset frames themselves.
          for (const f of this.preOnsetRoll) this.emitChunk(f)
          for (const f of this.onsetBuffer)  this.emitChunk(f)
          this.onsetFrames = 0
          this.onsetBuffer = []
          this.preOnsetRoll = []
        }
      }
    } else {
      this.emitChunk(frame)

      if (prob >= this.vadEndThreshold) {
        this.silentFrames = 0
      } else {
        this.silentFrames++
        if (this.silentFrames >= this.silenceLimit) {
          this.speaking = false
          this.silentFrames = 0
          this.onSpeechEnd()
        }
      }
    }
  }

  private onSpeechEnd(): void {
    this.onMessage({ type: 'speech-end' })
    // Ask the worker to reset LSTM state so the next utterance starts fresh.
    if (!this.fallbackMode) {
      this.worker?.postMessage({ type: 'reset-state' })
    }
  }

  private emitChunk(frame: Float32Array): void {
    // frame is always backed by a plain ArrayBuffer (never SharedArrayBuffer)
    // since it originates from Float32Array() allocations we control.
    this.onMessage({ type: 'audio-chunk', chunk: frame.buffer.slice(0) as ArrayBuffer })
  }

  // ── Fallback (RMS) ───────────────────────────────────────────────────────────

  private activateFallback(): void {
    this.fallbackMode = true
    this.workerReady = false
    // Process any frames that were queued while waiting for the worker.
    const queued = this.pendingFrames.splice(0)
    for (const f of queued) {
      this.applyVad(f, this.rmsProb(f))
    }
  }

  /** Map raw PCM RMS to a synthetic speech probability for fallback mode. */
  private rmsProb(frame: Float32Array): number {
    const rms = this.computeRms(frame)
    if (rms >= FALLBACK_RMS_START) return 1.0
    if (rms >= FALLBACK_RMS_END)   return 0.4 // between thresholds: treat as borderline
    return 0.0
  }
}
