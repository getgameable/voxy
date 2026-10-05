import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../voxy'

describe('DEFAULT_CONFIG', () => {
  it('uses a 16 kHz mic by default (matches VAD target rate)', () => {
    expect(DEFAULT_CONFIG.sampleRate).toBe(16000)
  })

  it('has start threshold > end threshold (hysteresis invariant)', () => {
    expect(DEFAULT_CONFIG.vadThreshold).toBeGreaterThan(DEFAULT_CONFIG.vadEndThreshold)
  })

  it('has positive pre-roll, silence timeout and calibration windows', () => {
    expect(DEFAULT_CONFIG.preRollMs).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.silenceTimeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.calibrationMs).toBeGreaterThan(0)
  })

  it('enables noise suppression with a relative WASM URL by default', () => {
    expect(DEFAULT_CONFIG.noiseSuppression).toBe(true)
    expect(DEFAULT_CONFIG.noiseSuppressionUrl).toMatch(/\.wasm$/)
  })

  it('enables the energy gate with sensible parameters', () => {
    expect(DEFAULT_CONFIG.energyGateEnabled).toBe(true)
    expect(DEFAULT_CONFIG.energyGateMult).toBeGreaterThan(1)
    expect(DEFAULT_CONFIG.noiseAdaptRate).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.noiseAdaptRate).toBeLessThan(1)
  })

  it('points at a Silero ONNX model URL', () => {
    expect(DEFAULT_CONFIG.modelUrl).toMatch(/\.onnx$/)
  })
})
