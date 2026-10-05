import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MockWorker } from '../../../test/mocks/worker'
import type { WorkletMessage } from '../AudioPipeline'
import type { VadEngineConfig } from '../VadEngine'
import { silentFrame, noiseFrame, toneFrame, FRAME_SIZE } from '../../../test/fixtures/frames'

// The worker module is loaded through Vite's ?worker suffix in production;
// stub it to return the MockWorker class.
vi.mock('../workers/vad-worker?worker', () => ({ default: MockWorker }))

// Import after mock registration so VadEngine picks up the stub.
const { VadEngine } = await import('../VadEngine')

// ── Helpers ────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<VadEngineConfig> = {}): VadEngineConfig {
  return {
    modelUrl: '/fake-model.onnx',
    vadThreshold: 0.6,
    vadEndThreshold: 0.3,
    preRollMs: 96,      // 3 × 32ms frames
    silenceTimeoutMs: 64, // 2 frames
    minSpeechMs: 0,     // single-frame trigger
    energyGateEnabled: false,
    energyGateMult: 2.5,
    noiseAdaptRate: 0.005,
    calibrationMs: 0,
    ...overrides,
  }
}

/** Drive a single frame through the engine and (optionally) simulate the
 *  worker replying with a given probability. */
function tick(engine: InstanceType<typeof VadEngine>, frame: Float32Array, prob?: number): void {
  engine.processFrame(frame)
  if (prob !== undefined) {
    MockWorker.instances[0].emit({ type: 'prob', value: prob })
  }
}

describe('VadEngine', () => {
  let onMessage: ReturnType<typeof vi.fn<(m: WorkletMessage) => void>>
  let onWarn:    ReturnType<typeof vi.fn<(code: string, message: string) => void>>
  let onFrame:   ReturnType<typeof vi.fn<(p: number, a: number, n: number, g: boolean) => void>>

  beforeEach(() => {
    MockWorker.reset()
    onMessage = vi.fn()
    onWarn    = vi.fn()
    onFrame   = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────

  it('start() constructs a worker and sends init with the model URL', () => {
    const engine = new VadEngine(baseConfig({ modelUrl: '/my-model.onnx' }), onMessage, onWarn)
    engine.start()

    expect(MockWorker.instances).toHaveLength(1)
    expect(MockWorker.instances[0].posted).toEqual([
      { type: 'init', modelUrl: '/my-model.onnx' },
    ])
  })

  it('queues frames that arrive before the worker is ready, drains on ready', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    const w = MockWorker.instances[0]

    engine.processFrame(silentFrame())
    engine.processFrame(silentFrame())

    // No 'frame' posted yet — still waiting on 'ready'
    expect(w.posted.filter(m => (m as { type: string }).type === 'frame')).toHaveLength(0)

    w.emit({ type: 'ready' })

    // On ready, the engine sends the first pending frame and keeps the rest queued.
    expect(w.posted.filter(m => (m as { type: string }).type === 'frame')).toHaveLength(1)
  })

  it('enters VAD_FALLBACK when worker construction throws', () => {
    MockWorker.throwOnNextConstruction = new Error('boom')

    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()

    expect(onWarn).toHaveBeenCalledWith(
      'VAD_FALLBACK',
      expect.stringMatching(/Failed to construct VAD worker/),
    )

    // In fallback mode, loud frames should trigger speech-start without a worker.
    engine.processFrame(toneFrame(440, 0.3))  // RMS ≈ 0.21, well above FALLBACK_RMS_START
    expect(onMessage.mock.calls.some(c => c[0].type === 'speech-start')).toBe(true)
  })

  it('switches to VAD_FALLBACK on worker init error and keeps running', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    const w = MockWorker.instances[0]

    w.emit({ type: 'error', during: 'init', message: 'onnx parse failed' })

    expect(onWarn).toHaveBeenCalledWith(
      'VAD_FALLBACK',
      expect.stringMatching(/Silero model failed to load/),
    )
  })

  it('warns VAD_INFERENCE_ERROR on per-frame failure without falling back', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    engine.processFrame(silentFrame())
    w.emit({ type: 'error', during: 'inference', message: 'tensor mismatch' })

    expect(onWarn).toHaveBeenCalledWith('VAD_INFERENCE_ERROR', 'tensor mismatch')
    // After draining the in-flight frame, a new frame should be sent to the worker — NOT routed through fallback.
    engine.processFrame(silentFrame())
    const frameMsgs = w.posted.filter(m => (m as { type: string }).type === 'frame')
    expect(frameMsgs.length).toBeGreaterThanOrEqual(2)
  })

  it('activates fallback on worker onerror', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    MockWorker.instances[0].error('worker died')

    expect(onWarn).toHaveBeenCalledWith(
      'VAD_FALLBACK',
      expect.stringMatching(/Worker error/),
    )
  })

  // ── VAD decision (happy path) ────────────────────────────────────────────

  it('emits speech-start → audio-chunk(s) → speech-end across one utterance', () => {
    const engine = new VadEngine(
      baseConfig({ minSpeechMs: 0, silenceTimeoutMs: 64 }),
      onMessage, onWarn,
    )
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // Frame 1 — prob above start threshold → speech-start
    tick(engine, silentFrame(), 0.9)
    // Frame 2 — continuation
    tick(engine, silentFrame(), 0.8)
    // Frames 3 & 4 — below end threshold → silenceLimit (2) hit
    tick(engine, silentFrame(), 0.1)
    tick(engine, silentFrame(), 0.1)

    const types = onMessage.mock.calls.map(c => c[0].type)
    expect(types[0]).toBe('speech-start')
    expect(types[types.length - 1]).toBe('speech-end')
    expect(types.filter(t => t === 'audio-chunk').length).toBeGreaterThan(0)
  })

  it('requires `minSpeechMs` consecutive active frames before confirming speech-start (hysteresis)', () => {
    const engine = new VadEngine(
      baseConfig({ minSpeechMs: 96 }),  // 3 frames @ 32ms
      onMessage, onWarn,
    )
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // One frame above threshold, then a dip below end threshold — should cancel onset.
    tick(engine, silentFrame(), 0.9)
    tick(engine, silentFrame(), 0.1)
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeUndefined()

    // Now three consecutive active frames → speech-start must fire.
    tick(engine, silentFrame(), 0.9)
    tick(engine, silentFrame(), 0.9)
    tick(engine, silentFrame(), 0.9)
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeDefined()
  })

  it('sends reset-state to the worker after speech-end', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    tick(engine, silentFrame(), 0.9)
    tick(engine, silentFrame(), 0.1)
    tick(engine, silentFrame(), 0.1)

    expect(w.posted).toContainEqual({ type: 'reset-state' })
  })

  it('flushes pre-roll audio before the onset frame on speech-start', () => {
    const engine = new VadEngine(
      baseConfig({ preRollMs: 96, minSpeechMs: 0 }),
      onMessage, onWarn,
    )
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // Three silent frames — all go into preRoll.
    // With async inference, each frame's prob comes back before the next processFrame,
    // so preOnsetRoll = preRoll.slice(0, -1) captures frames prior to the onset frame.
    tick(engine, silentFrame(), 0.0)
    tick(engine, silentFrame(), 0.0)
    // Onset frame
    tick(engine, silentFrame(), 0.9)

    const chunks = onMessage.mock.calls.filter(c => c[0].type === 'audio-chunk')
    // At least 3: two pre-roll + the onset itself.
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  // ── Fallback RMS mode ────────────────────────────────────────────────────

  it('in fallback mode, low-amplitude frames do not trigger speech', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    MockWorker.instances[0].emit({ type: 'error', during: 'init', message: 'x' })

    // Silent frames in fallback mode → no speech-start
    for (let i = 0; i < 5; i++) engine.processFrame(silentFrame())

    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeUndefined()
  })

  it('in fallback mode, loud frames trigger speech-start via RMS threshold', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    MockWorker.instances[0].emit({ type: 'error', during: 'init', message: 'x' })

    // Tone at amp 0.3 has RMS ≈ 0.21 >> FALLBACK_RMS_START (0.02)
    engine.processFrame(toneFrame(440, 0.3))
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeDefined()
  })

  // ── Energy gate / noise floor ────────────────────────────────────────────

  it('energy gate suppresses VAD on low-RMS frames after calibration', () => {
    const engine = new VadEngine(
      baseConfig({
        energyGateEnabled: true,
        energyGateMult: 2.5,
        calibrationMs: 64,  // 2 frames to calibrate
        minSpeechMs: 0,
      }),
      onMessage, onWarn, onFrame,
    )
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // Calibrate with two noise frames at RMS ≈ 0.01; prob <0.3 so they count.
    tick(engine, noiseFrame(0.02, 1), 0.1)
    tick(engine, noiseFrame(0.02, 2), 0.1)

    // Now a frame with high prob but LOW RMS — energy gate should clamp prob to 0.
    const quiet = noiseFrame(0.005, 3)
    tick(engine, quiet, 0.9)

    // onFrame receives the gated prob — should be 0.
    const lastFrameCall = onFrame.mock.calls.at(-1)!
    expect(lastFrameCall[0]).toBe(0)   // prob
    expect(lastFrameCall[3]).toBe(true) // gated
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeUndefined()
  })

  it('resetNoiseFloor() clears calibration so the next frames recalibrate', () => {
    const engine = new VadEngine(
      baseConfig({ energyGateEnabled: true, calibrationMs: 32 }),
      onMessage, onWarn, onFrame,
    )
    engine.start()
    MockWorker.instances[0].emit({ type: 'ready' })

    // Calibrate with one noise frame.
    tick(engine, noiseFrame(0.02, 1), 0.1)
    const calibratedFloor = onFrame.mock.calls.at(-1)![2]
    expect(calibratedFloor).toBeGreaterThan(0)

    engine.resetNoiseFloor()

    // Now onFrame.noiseFloor should report 0 again after first post-reset frame
    // because calibration restarts.
    tick(engine, silentFrame(), 0.0)
    const afterReset = onFrame.mock.calls.at(-1)![2]
    // Either 0 (if the frame's RMS was ~0) or much smaller than before.
    expect(afterReset).toBeLessThan(calibratedFloor)
  })

  // ── Config update ────────────────────────────────────────────────────────

  it('updateConfig() changes the start/end thresholds at runtime', () => {
    const engine = new VadEngine(
      baseConfig({ vadThreshold: 0.9, vadEndThreshold: 0.8, minSpeechMs: 0 }),
      onMessage, onWarn,
    )
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // 0.7 is below 0.9 — would NOT trigger with starting config.
    tick(engine, silentFrame(), 0.7)
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeUndefined()

    engine.updateConfig({ vadThreshold: 0.6, vadEndThreshold: 0.3 })

    // 0.7 now >= 0.6 → should trigger.
    tick(engine, silentFrame(), 0.7)
    expect(onMessage.mock.calls.find(c => c[0].type === 'speech-start')).toBeDefined()
  })

  // ── Stop ─────────────────────────────────────────────────────────────────

  it('stop() terminates the worker and clears internal state', () => {
    const engine = new VadEngine(baseConfig(), onMessage, onWarn)
    engine.start()
    const w = MockWorker.instances[0]
    w.emit({ type: 'ready' })

    // Build up some state
    tick(engine, silentFrame(), 0.9)
    tick(engine, silentFrame(), 0.8)

    engine.stop()

    expect(w.terminate).toHaveBeenCalledOnce()

    // After stop(), further frames do not reach the (terminated) worker or
    // the message callback (worker is null, not ready).
    onMessage.mockClear()
    engine.processFrame(silentFrame())
    expect(onMessage).not.toHaveBeenCalled()
  })

  // ── Frame contract ──────────────────────────────────────────────────────

  it('emitted audio-chunk buffers are ArrayBuffer-sized to one 16kHz frame', () => {
    const engine = new VadEngine(baseConfig({ minSpeechMs: 0 }), onMessage, onWarn)
    engine.start()
    MockWorker.instances[0].emit({ type: 'ready' })

    tick(engine, silentFrame(), 0.9)

    const chunk = onMessage.mock.calls.find(c => c[0].type === 'audio-chunk')?.[0]
    expect(chunk).toBeDefined()
    if (chunk && chunk.type === 'audio-chunk') {
      // 512 samples × 4 bytes (Float32) = 2048 bytes
      expect(chunk.chunk.byteLength).toBe(FRAME_SIZE * 4)
    }
  })
})
