/**
 * Synthetic PCM frame generators used across VAD/pipeline tests.
 *
 * All frames are 512 samples at 16 kHz (matches what the AudioWorklet
 * emits and what VadEngine consumes).
 */

export const FRAME_SIZE = 512

/** Silent frame (all zeros). */
export function silentFrame(): Float32Array {
  return new Float32Array(FRAME_SIZE)
}

/** Uniform noise in [-amp, amp]. Deterministic via a simple LCG seed. */
export function noiseFrame(amp: number, seed = 1): Float32Array {
  const f = new Float32Array(FRAME_SIZE)
  let s = seed >>> 0
  for (let i = 0; i < FRAME_SIZE; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    f[i] = ((s / 0xffffffff) * 2 - 1) * amp
  }
  return f
}

/** Sine wave at `freq` Hz, `amp` magnitude — a "speech-like" tone. */
export function toneFrame(freq: number, amp: number, offset = 0): Float32Array {
  const f = new Float32Array(FRAME_SIZE)
  const w = (2 * Math.PI * freq) / 16000
  for (let i = 0; i < FRAME_SIZE; i++) f[i] = Math.sin(w * (i + offset)) * amp
  return f
}

/** RMS of a frame — used in assertions. */
export function rms(frame: Float32Array): number {
  let sum = 0
  for (const s of frame) sum += s * s
  return Math.sqrt(sum / frame.length)
}
