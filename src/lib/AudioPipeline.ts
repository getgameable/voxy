import workletSource from './worklet/vad-processor.js?raw'

// AudioWorklet.addModule() needs a URL pointing to valid JS.  Vite's ?url
// suffix inlines a data-URI with the wrong MIME type (video/mp2t) when
// building in lib mode, which browsers reject.  Instead we import the raw
// source and create a Blob URL with the correct MIME at runtime.
const workletUrl = URL.createObjectURL(
  new Blob([workletSource], { type: 'application/javascript' }),
)
import { VadEngine } from './VadEngine'
import type { VadEngineConfig } from './VadEngine'

export type MicErrorCode = 'MIC_DENIED' | 'MIC_UNAVAILABLE' | 'AUDIO_CONTEXT_FAILED'

export class MicError extends Error {
  readonly code: MicErrorCode

  constructor(code: MicErrorCode, message: string) {
    super(message)
    this.name = 'MicError'
    this.code = code
  }
}

export type WorkletMessage =
  | { type: 'speech-start' }
  | { type: 'audio-chunk'; chunk: ArrayBuffer }
  | { type: 'speech-end' }

export interface PipelineConfig {
  sampleRate: number
  silenceTimeoutMs: number
  vadThreshold: number
  vadEndThreshold: number
  preRollMs: number
  minSpeechMs: number
  modelUrl: string
  noiseSuppression: boolean
  noiseSuppressionUrl: string
  energyGateEnabled: boolean
  energyGateMult: number
  noiseAdaptRate: number
  calibrationMs: number
}

export class AudioPipeline {
  // Mutable copy — updated by updateConfig() before and after start().
  private readonly liveConfig: PipelineConfig
  private readonly onMessage: (msg: WorkletMessage) => void
  private readonly onWarn: (code: string, message: string) => void
  private readonly onFrame: ((prob: number, amplitude: number, noiseFloor: number, gated: boolean) => void) | undefined

  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private vadEngine: VadEngine | null = null

  constructor(
    config: PipelineConfig,
    onMessage: (msg: WorkletMessage) => void,
    onWarn: (code: string, message: string) => void,
    onFrame?: (prob: number, amplitude: number, noiseFloor: number, gated: boolean) => void,
  ) {
    this.liveConfig = { ...config }
    this.onMessage  = onMessage
    this.onWarn     = onWarn
    this.onFrame    = onFrame
  }

  async start(): Promise<void> {
    // ── 1. Microphone permission ─────────────────────────────────────────────
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.liveConfig.sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: this.liveConfig.noiseSuppression,
          autoGainControl: true,
        },
        video: false,
      })
    } catch (err) {
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          throw new MicError('MIC_DENIED', 'Microphone permission denied')
        }
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          throw new MicError('MIC_UNAVAILABLE', 'No microphone found')
        }
      }
      throw new MicError('MIC_UNAVAILABLE', `getUserMedia failed: ${String(err)}`)
    }

    // ── 2. AudioContext ──────────────────────────────────────────────────────
    let context: AudioContext
    try {
      context = new AudioContext({ sampleRate: this.liveConfig.sampleRate })
      if (context.state === 'suspended') await context.resume()
      console.log(`[Voxy-AudioPipeline] AudioContext sampleRate=${context.sampleRate} (requested=${this.liveConfig.sampleRate})`)
    } catch (err) {
      stream.getTracks().forEach(t => t.stop())
      throw new MicError('AUDIO_CONTEXT_FAILED', `AudioContext creation failed: ${String(err)}`)
    }

    // ── 3. AudioWorklet ──────────────────────────────────────────────────────
    try {
      console.log('[Voxy-AudioPipeline] loading AudioWorklet module...')
      await context.audioWorklet.addModule(workletUrl)
      console.log('[Voxy-AudioPipeline] AudioWorklet module loaded')
    } catch (err) {
      console.error('[Voxy-AudioPipeline] AudioWorklet failed:', err)
      stream.getTracks().forEach(t => t.stop())
      await context.close().catch(() => {})
      throw new MicError('AUDIO_CONTEXT_FAILED', `AudioWorklet failed to load: ${String(err)}`)
    }

    const workletNode = new AudioWorkletNode(context, 'vad-processor')
    console.log('[Voxy-AudioPipeline] AudioWorkletNode created')

    // ── 3.5. RNNoise WASM (optional) ────────────────────────────────────────
    if (this.liveConfig.noiseSuppression) {
      try {
        console.log('[Voxy-AudioPipeline] fetching RNNoise WASM:', this.liveConfig.noiseSuppressionUrl)
        const wasmResponse = await fetch(this.liveConfig.noiseSuppressionUrl)
        if (!wasmResponse.ok) throw new Error(`HTTP ${wasmResponse.status} ${wasmResponse.statusText}`)
        const wasmBytes = await wasmResponse.arrayBuffer()

        // Send raw WASM bytes to the worklet (not a compiled Module — AudioWorklet
        // may not support structured-cloning of WebAssembly.Module in all browsers).
        // The worklet will compile + instantiate synchronously.
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('RNNoise init timeout (5s)')), 5000)
          const handler = (e: MessageEvent) => {
            if (e.data.type === 'rnnoise-ready') {
              clearTimeout(timeout)
              workletNode.port.removeEventListener('message', handler)
              resolve()
            } else if (e.data.type === 'rnnoise-error') {
              clearTimeout(timeout)
              workletNode.port.removeEventListener('message', handler)
              reject(new Error(e.data.message as string))
            }
          }
          workletNode.port.addEventListener('message', handler)
          workletNode.port.start()
          workletNode.port.postMessage(
            { type: 'init-rnnoise', wasmBytes },
            [wasmBytes],  // transfer zero-copy
          )
        })
        console.log('[Voxy-AudioPipeline] RNNoise initialized in worklet')
      } catch (err) {
        this.onWarn('NOISE_SUPPRESSION_UNAVAILABLE', `RNNoise failed to load: ${String(err)}`)
      }
    }

    // ── 4. VadEngine ─────────────────────────────────────────────────────────
    const vadConfig: VadEngineConfig = {
      modelUrl:         this.liveConfig.modelUrl,
      vadThreshold:     this.liveConfig.vadThreshold,
      vadEndThreshold:  this.liveConfig.vadEndThreshold,
      preRollMs:        this.liveConfig.preRollMs,
      silenceTimeoutMs: this.liveConfig.silenceTimeoutMs,
      minSpeechMs:      this.liveConfig.minSpeechMs,
      energyGateEnabled: this.liveConfig.energyGateEnabled,
      energyGateMult:    this.liveConfig.energyGateMult,
      noiseAdaptRate:    this.liveConfig.noiseAdaptRate,
      calibrationMs:     this.liveConfig.calibrationMs,
    }
    console.log('[Voxy-AudioPipeline] creating VadEngine, modelUrl:', vadConfig.modelUrl)
    const vadEngine = new VadEngine(vadConfig, this.onMessage, this.onWarn, this.onFrame)
    console.log('[Voxy-AudioPipeline] calling vadEngine.start()...')
    vadEngine.start()
    console.log('[Voxy-AudioPipeline] VadEngine started')

    // Route raw frames from the worklet through VadEngine.
    workletNode.port.onmessage = (e: MessageEvent<{ type: string; samples?: ArrayBuffer; message?: string }>) => {
      if (e.data.type === 'frame') {
        vadEngine.processFrame(new Float32Array(e.data.samples!))
      } else if (e.data.type === 'rnnoise-error') {
        this.onWarn('NOISE_SUPPRESSION_UNAVAILABLE', e.data.message ?? 'RNNoise runtime error')
      }
    }

    // ── 5. Connect graph ──────────────────────────────────────────────────────
    const source = context.createMediaStreamSource(stream)
    source.connect(workletNode)
    console.log('[Voxy-AudioPipeline] audio graph connected — pipeline ready')

    this.stream     = stream
    this.context    = context
    this.source     = source
    this.workletNode = workletNode
    this.vadEngine  = vadEngine
  }

  stop(): void {
    this.vadEngine?.stop()
    this.vadEngine = null

    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }

    this.source?.disconnect()
    this.source = null

    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null

    if (this.context) {
      this.context.close().catch(() => {})
      this.context = null
    }
  }

  /** Silence/unmute the mic track without closing the AudioContext. */
  setInputEnabled(enabled: boolean): void {
    this.stream?.getAudioTracks().forEach(t => { t.enabled = enabled })
  }

  /** Update VAD config. Persists to liveConfig and forwards to VadEngine if running. */
  updateConfig(partial: { vadThreshold?: number; vadEndThreshold?: number; silenceTimeoutMs?: number; minSpeechMs?: number; energyGateEnabled?: boolean; energyGateMult?: number; noiseAdaptRate?: number }): void {
    if (partial.vadThreshold    != null) this.liveConfig.vadThreshold    = partial.vadThreshold
    if (partial.vadEndThreshold != null) this.liveConfig.vadEndThreshold = partial.vadEndThreshold
    if (partial.silenceTimeoutMs != null) this.liveConfig.silenceTimeoutMs = partial.silenceTimeoutMs
    if (partial.minSpeechMs     != null) this.liveConfig.minSpeechMs     = partial.minSpeechMs
    if (partial.energyGateEnabled != null) this.liveConfig.energyGateEnabled = partial.energyGateEnabled
    if (partial.energyGateMult   != null) this.liveConfig.energyGateMult   = partial.energyGateMult
    if (partial.noiseAdaptRate   != null) this.liveConfig.noiseAdaptRate   = partial.noiseAdaptRate
    this.vadEngine?.updateConfig(partial)
  }

  /** Force re-calibration of the noise floor estimate. */
  resetNoiseFloor(): void {
    this.vadEngine?.resetNoiseFloor()
  }

  getContext(): AudioContext | null { return this.context }
  getStream(): MediaStream | null   { return this.stream  }
}
