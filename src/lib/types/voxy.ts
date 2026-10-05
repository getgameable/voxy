export type VoxyState = 'IDLE' | 'LISTENING' | 'AVATAR_SPEAKING' | 'USER_SPEAKING' | 'MUTED'

export interface VoxyConfig {
  sampleRate: number
  silenceTimeoutMs: number
  // Silero VAD thresholds (speech probability 0–1).
  // Falls back to RMS energy detection if the model fails to load (warn: VAD_FALLBACK).
  vadThreshold: number      // probability to trigger speech-start
  vadEndThreshold: number   // probability below which silence is counted
  preRollMs: number
  minSpeechMs: number   // consecutive VAD-active audio required before speech-start fires
  noiseSuppression: boolean
  noiseSuppressionUrl: string  // URL to standalone RNNoise WASM binary
  modelUrl: string
  // Energy gate — rejects frames whose RMS is indistinguishable from the noise floor.
  energyGateEnabled: boolean  // enable adaptive energy gate (default true)
  energyGateMult: number      // frame RMS must exceed noiseFloor × this to pass (default 2.5)
  noiseAdaptRate: number      // EMA alpha for slow noise floor adaptation (default 0.005)
  calibrationMs: number       // initial calibration period in ms (default 960)
}

export const DEFAULT_CONFIG: VoxyConfig = {
  sampleRate: 16000,
  silenceTimeoutMs: 800,
  vadThreshold: 0.7,
  vadEndThreshold: 0.35,
  preRollMs: 500,
  minSpeechMs: 150,
  noiseSuppression: true,
  noiseSuppressionUrl: '/wasm/rnnoise.wasm',
  modelUrl: '/models/silero_vad.onnx',
  energyGateEnabled: true,
  energyGateMult: 2.5,
  noiseAdaptRate: 0.005,
  calibrationMs: 960,
}

export interface StateChangePayload { from: VoxyState | null; to: VoxyState }
export interface AudioChunkPayload { chunk: ArrayBuffer; timestamp: number; sequenceId: number }
export interface SpeechEndPayload { durationMs: number; sequenceId: number }
export interface UtteranceAudioPayload { audio: Blob; sequenceId: number; durationMs: number }
export interface MuteChangePayload { muted: boolean }
export interface BargeInPayload { sequenceId: number }
export interface WarnPayload { code: string; message: string }
export interface ErrorPayload { code: string; message: string }
export interface TextSubmitPayload { text: string }
export interface VadFramePayload { prob: number; amplitude: number; noiseFloor: number; gated: boolean }

export interface IVoxyCore {
  on<K extends keyof VoxyEventMap>(event: K, handler: (p: VoxyEventMap[K]) => void): void
  off<K extends keyof VoxyEventMap>(event: K, handler: (p: VoxyEventMap[K]) => void): void
  start(): Promise<void>
  stop(): void
  mute(): void
  unmute(): void
  avatarSpeaking(): void
  avatarIdle(): void
  getState(): VoxyState
  isStarted(): boolean
  resetNoiseFloor(): void
}

export type VoxyEventMap = {
  'state-change': StateChangePayload
  'barge-in': BargeInPayload
  'speech-start': { sequenceId: number }
  'audio-chunk': AudioChunkPayload
  'speech-end': SpeechEndPayload
  'utterance-audio': UtteranceAudioPayload
  'text-submit': TextSubmitPayload
  'mute-change': MuteChangePayload
  'warn': WarnPayload
  'error': ErrorPayload
  'vad-frame': VadFramePayload
}
