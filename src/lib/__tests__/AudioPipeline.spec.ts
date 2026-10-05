import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installAudioMocks,
  restoreAudioMocks,
  type AudioMockHandles,
} from '../../../test/mocks/audio'

// The worklet source is imported via Vite's ?raw suffix in production.
vi.mock('../worklet/vad-processor.js?raw', () => ({ default: '/* stub worklet */' }))

// VadEngine is covered by its own spec; stub it out so AudioPipeline tests
// only exercise the pipeline wiring, not VAD behaviour.
const vadEngineStub = {
  start:           vi.fn(),
  stop:            vi.fn(),
  processFrame:    vi.fn(),
  updateConfig:    vi.fn(),
  resetNoiseFloor: vi.fn(),
}
vi.mock('../VadEngine', () => ({
  VadEngine: class {
    start           = vadEngineStub.start
    stop            = vadEngineStub.stop
    processFrame    = vadEngineStub.processFrame
    updateConfig    = vadEngineStub.updateConfig
    resetNoiseFloor = vadEngineStub.resetNoiseFloor
  },
}))

const { AudioPipeline, MicError } = await import('../AudioPipeline')
import type { PipelineConfig, WorkletMessage } from '../AudioPipeline'

// ── Helpers ────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    sampleRate:          16000,
    silenceTimeoutMs:    800,
    vadThreshold:        0.6,
    vadEndThreshold:     0.3,
    preRollMs:           500,
    minSpeechMs:         0,
    modelUrl:            '/models/silero.onnx',
    noiseSuppression:    false,
    noiseSuppressionUrl: '/wasm/rnnoise.wasm',
    energyGateEnabled:   true,
    energyGateMult:      2.5,
    noiseAdaptRate:      0.005,
    calibrationMs:       0,
    ...overrides,
  }
}

function mockOkFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => new ArrayBuffer(16),
  }))
}

describe('AudioPipeline', () => {
  let onMessage: ReturnType<typeof vi.fn<(m: WorkletMessage) => void>>
  let onWarn:    ReturnType<typeof vi.fn<(code: string, message: string) => void>>
  let handles:   AudioMockHandles

  beforeEach(() => {
    onMessage = vi.fn()
    onWarn    = vi.fn()
    vadEngineStub.start.mockClear()
    vadEngineStub.stop.mockClear()
    vadEngineStub.processFrame.mockClear()
    vadEngineStub.updateConfig.mockClear()
    vadEngineStub.resetNoiseFloor.mockClear()
  })

  afterEach(() => {
    restoreAudioMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // ── start() — no noise suppression ────────────────────────────────────────

  it('start() connects the audio graph: getUserMedia → worklet → VadEngine.start', async () => {
    handles = installAudioMocks()

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    expect(handles.getUserMedia).toHaveBeenCalledOnce()
    expect(handles.audioContextCtorCalls()).toBe(1)
    expect(handles.contexts[0].audioWorklet.addModule).toHaveBeenCalledOnce()
    expect(handles.workletNodeCtorCalls()).toBe(1)
    expect(handles.lastWorkletNodeArgs()).toEqual([handles.contexts[0], 'vad-processor'])
    expect(handles.contexts[0].createMediaStreamSource).toHaveBeenCalledWith(handles.streams[0])
    expect(vadEngineStub.start).toHaveBeenCalledOnce()
  })

  it('start() resumes a suspended AudioContext', async () => {
    handles = installAudioMocks({ contextOptions: { suspended: true } })

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    expect(handles.contexts[0].resume).toHaveBeenCalledOnce()
  })

  it('start() passes noiseSuppression through to getUserMedia constraints', async () => {
    handles = installAudioMocks()

    const pipeline = new AudioPipeline(baseConfig({ noiseSuppression: true }), onMessage, onWarn)
    // Use a fetch stub so the noise-suppression branch doesn't block; reject so
    // init fails quickly and the test only cares about the constraint object.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('skip') }))

    await pipeline.start()

    const [constraints] = handles.getUserMedia.mock.calls[0]
    expect((constraints.audio as MediaTrackConstraints).noiseSuppression).toBe(true)
  })

  // ── getUserMedia failures ─────────────────────────────────────────────────

  it('maps NotAllowedError → MIC_DENIED', async () => {
    const err = Object.assign(new DOMException('denied', 'NotAllowedError'))
    handles = installAudioMocks({ getUserMediaError: err })

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await expect(pipeline.start()).rejects.toBeInstanceOf(MicError)
    await expect(pipeline.start()).rejects.toMatchObject({ code: 'MIC_DENIED' })
  })

  it('maps NotFoundError → MIC_UNAVAILABLE', async () => {
    const err = Object.assign(new DOMException('no device', 'NotFoundError'))
    handles = installAudioMocks({ getUserMediaError: err })

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await expect(pipeline.start()).rejects.toMatchObject({ code: 'MIC_UNAVAILABLE' })
  })

  it('maps unexpected getUserMedia errors → MIC_UNAVAILABLE', async () => {
    handles = installAudioMocks({ getUserMediaError: new Error('boom') })

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await expect(pipeline.start()).rejects.toMatchObject({ code: 'MIC_UNAVAILABLE' })
  })

  it('tears down the stream + context if addModule fails (AUDIO_CONTEXT_FAILED)', async () => {
    handles = installAudioMocks({ contextOptions: { addModuleError: new Error('worklet broken') } })

    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await expect(pipeline.start()).rejects.toMatchObject({ code: 'AUDIO_CONTEXT_FAILED' })

    expect(handles.streams[0].getTracks()[0].stop).toHaveBeenCalledOnce()
    expect(handles.contexts[0].close).toHaveBeenCalledOnce()
  })

  // ── RNNoise init (happy path) ────────────────────────────────────────────

  it('RNNoise: fetches the configured URL and posts init-rnnoise to the worklet', async () => {
    handles = installAudioMocks()
    const fetchStub = mockOkFetch()
    vi.stubGlobal('fetch', fetchStub)

    const pipeline = new AudioPipeline(
      baseConfig({ noiseSuppression: true, noiseSuppressionUrl: '/custom/rnnoise.wasm' }),
      onMessage, onWarn,
    )

    const startPromise = pipeline.start()

    // Wait until the init-rnnoise message has been posted (microtask flush).
    await vi.waitFor(() => {
      expect(handles.workletNodes[0].port.postMessage).toHaveBeenCalled()
    })

    const firstPost = handles.workletNodes[0].port.postMessage.mock.calls[0]
    expect((firstPost[0] as { type: string }).type).toBe('init-rnnoise')
    // bytes transferred zero-copy
    expect(firstPost[1]).toBeDefined()

    expect(fetchStub).toHaveBeenCalledWith('/custom/rnnoise.wasm')

    // Simulate the worklet signalling ready.
    handles.workletNodes[0].port.emit({ type: 'rnnoise-ready' })

    await startPromise
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('RNNoise: emits NOISE_SUPPRESSION_UNAVAILABLE on HTTP error (404)', async () => {
    handles = installAudioMocks()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
    })))

    const pipeline = new AudioPipeline(
      baseConfig({ noiseSuppression: true }),
      onMessage, onWarn,
    )
    await pipeline.start()

    expect(onWarn).toHaveBeenCalledWith(
      'NOISE_SUPPRESSION_UNAVAILABLE',
      expect.stringMatching(/HTTP 404/),
    )
    // Pipeline continued despite the failure.
    expect(vadEngineStub.start).toHaveBeenCalledOnce()
  })

  it('RNNoise: emits NOISE_SUPPRESSION_UNAVAILABLE when fetch rejects', async () => {
    handles = installAudioMocks()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network error') }))

    const pipeline = new AudioPipeline(
      baseConfig({ noiseSuppression: true }),
      onMessage, onWarn,
    )
    await pipeline.start()

    expect(onWarn).toHaveBeenCalledWith(
      'NOISE_SUPPRESSION_UNAVAILABLE',
      expect.stringMatching(/network error/),
    )
  })

  it('RNNoise: forwards worklet-side init failure as NOISE_SUPPRESSION_UNAVAILABLE', async () => {
    handles = installAudioMocks()
    vi.stubGlobal('fetch', mockOkFetch())

    const pipeline = new AudioPipeline(
      baseConfig({ noiseSuppression: true }),
      onMessage, onWarn,
    )
    const startPromise = pipeline.start()

    await vi.waitFor(() => {
      expect(handles.workletNodes[0].port.postMessage).toHaveBeenCalled()
    })

    handles.workletNodes[0].port.emit({ type: 'rnnoise-error', message: 'WASM parse failed' })

    await startPromise

    expect(onWarn).toHaveBeenCalledWith(
      'NOISE_SUPPRESSION_UNAVAILABLE',
      expect.stringMatching(/WASM parse failed/),
    )
  })

  it('RNNoise: skipped entirely when noiseSuppression is false', async () => {
    handles = installAudioMocks()
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)

    const pipeline = new AudioPipeline(baseConfig({ noiseSuppression: false }), onMessage, onWarn)
    await pipeline.start()

    expect(fetchStub).not.toHaveBeenCalled()
    // no init-rnnoise posted
    const sawInit = handles.workletNodes[0].port.postMessage.mock.calls.some(
      (args) => (args[0] as { type: string }).type === 'init-rnnoise',
    )
    expect(sawInit).toBe(false)
  })

  it('RNNoise: times out and warns if the worklet never replies', async () => {
    handles = installAudioMocks()
    vi.stubGlobal('fetch', mockOkFetch())
    vi.useFakeTimers()

    const pipeline = new AudioPipeline(baseConfig({ noiseSuppression: true }), onMessage, onWarn)

    const startPromise = pipeline.start()

    // Flush microtasks for the fetch + arrayBuffer promises to settle
    // and the setTimeout(5000) to be registered.
    await vi.waitFor(
      () => expect(handles.workletNodes[0]?.port.postMessage).toHaveBeenCalled(),
      { timeout: 2000, interval: 10 },
    )
    // Advance past the 5-second guard.
    await vi.advanceTimersByTimeAsync(5001)

    await startPromise

    expect(onWarn).toHaveBeenCalledWith(
      'NOISE_SUPPRESSION_UNAVAILABLE',
      expect.stringMatching(/timeout/),
    )
  })

  // ── Runtime message routing ─────────────────────────────────────────────

  it('forwards frame messages from the worklet into VadEngine.processFrame', async () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    const samples = new Float32Array(512).buffer
    handles.workletNodes[0].port.onmessage?.({ data: { type: 'frame', samples } } as MessageEvent)

    expect(vadEngineStub.processFrame).toHaveBeenCalledOnce()
    expect(vadEngineStub.processFrame.mock.calls[0][0]).toBeInstanceOf(Float32Array)
  })

  it('forwards runtime rnnoise-error from the worklet as a warn', async () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    handles.workletNodes[0].port.onmessage?.(
      { data: { type: 'rnnoise-error', message: 'runtime glitch' } } as MessageEvent,
    )

    expect(onWarn).toHaveBeenCalledWith('NOISE_SUPPRESSION_UNAVAILABLE', 'runtime glitch')
  })

  // ── Config update / mute / stop ─────────────────────────────────────────

  it('updateConfig() forwards partial config to VadEngine', async () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    pipeline.updateConfig({ vadThreshold: 0.8, silenceTimeoutMs: 1200 })

    expect(vadEngineStub.updateConfig).toHaveBeenCalledWith({
      vadThreshold: 0.8,
      silenceTimeoutMs: 1200,
    })
  })

  it('setInputEnabled(false) disables the mic track', async () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    pipeline.setInputEnabled(false)
    expect(handles.streams[0].getAudioTracks()[0].enabled).toBe(false)

    pipeline.setInputEnabled(true)
    expect(handles.streams[0].getAudioTracks()[0].enabled).toBe(true)
  })

  it('stop() tears down worklet, stream, context, and VadEngine in order', async () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    await pipeline.start()

    pipeline.stop()

    expect(vadEngineStub.stop).toHaveBeenCalledOnce()
    expect(handles.workletNodes[0].disconnect).toHaveBeenCalledOnce()
    expect(handles.streams[0].getTracks()[0].stop).toHaveBeenCalledOnce()
    expect(handles.contexts[0].close).toHaveBeenCalledOnce()
  })

  it('stop() is a no-op when called before start()', () => {
    handles = installAudioMocks()
    const pipeline = new AudioPipeline(baseConfig(), onMessage, onWarn)
    expect(() => pipeline.stop()).not.toThrow()
  })
})
