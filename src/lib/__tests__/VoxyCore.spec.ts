import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WorkletMessage } from '../AudioPipeline'

// ── Mock: AudioPipeline ────────────────────────────────────────────────────

/**
 * Holds references to the last-constructed pipeline stub's callbacks so
 * tests can drive worklet messages and warn events directly.
 */
const pipelineHandle: {
  onMessage: ((m: WorkletMessage) => void) | null
  onWarn:    ((code: string, message: string) => void) | null
  start:     ReturnType<typeof vi.fn>
  stop:      ReturnType<typeof vi.fn>
  setInputEnabled: ReturnType<typeof vi.fn>
  updateConfig:    ReturnType<typeof vi.fn>
  resetNoiseFloor: ReturnType<typeof vi.fn>
} = {
  onMessage: null,
  onWarn:    null,
  start:           vi.fn(),
  stop:            vi.fn(),
  setInputEnabled: vi.fn(),
  updateConfig:    vi.fn(),
  resetNoiseFloor: vi.fn(),
}

class MicErrorStub extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MicError'
    this.code = code
  }
}

vi.mock('../AudioPipeline', () => ({
  MicError: MicErrorStub,
  AudioPipeline: class {
    constructor(
      _config: unknown,
      onMessage: (m: WorkletMessage) => void,
      onWarn: (code: string, message: string) => void,
    ) {
      pipelineHandle.onMessage = onMessage
      pipelineHandle.onWarn    = onWarn
    }
    start           = pipelineHandle.start
    stop            = pipelineHandle.stop
    setInputEnabled = pipelineHandle.setInputEnabled
    updateConfig    = pipelineHandle.updateConfig
    resetNoiseFloor = pipelineHandle.resetNoiseFloor
  },
}))

const { VoxyCore } = await import('../VoxyCore')

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCore() {
  const core = new VoxyCore()
  const events = {
    stateChange:  vi.fn(),
    speechStart:  vi.fn(),
    audioChunk:   vi.fn(),
    speechEnd:    vi.fn(),
    utterance:    vi.fn(),
    bargeIn:      vi.fn(),
    muteChange:   vi.fn(),
    warn:         vi.fn(),
    error:        vi.fn(),
  }
  core.on('state-change', events.stateChange)
  core.on('speech-start', events.speechStart)
  core.on('audio-chunk', events.audioChunk)
  core.on('speech-end', events.speechEnd)
  core.on('utterance-audio', events.utterance)
  core.on('barge-in', events.bargeIn)
  core.on('mute-change', events.muteChange)
  core.on('warn', events.warn)
  core.on('error', events.error)
  return { core, events }
}

describe('VoxyCore', () => {
  beforeEach(() => {
    pipelineHandle.onMessage = null
    pipelineHandle.onWarn    = null
    pipelineHandle.start.mockReset().mockResolvedValue(undefined)
    pipelineHandle.stop.mockReset()
    pipelineHandle.setInputEnabled.mockReset()
    pipelineHandle.updateConfig.mockReset()
    pipelineHandle.resetNoiseFloor.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────

  it('starts in IDLE with isStarted() === false', () => {
    const { core } = makeCore()
    expect(core.getState()).toBe('IDLE')
    expect(core.isStarted()).toBe(false)
  })

  it('start() transitions IDLE → LISTENING and emits state-change', async () => {
    const { core, events } = makeCore()
    await core.start()

    expect(core.getState()).toBe('LISTENING')
    expect(core.isStarted()).toBe(true)
    expect(events.stateChange).toHaveBeenCalledWith({ from: 'IDLE', to: 'LISTENING' })
  })

  it('start() is a no-op when already started', async () => {
    const { core } = makeCore()
    await core.start()
    await core.start()

    expect(pipelineHandle.start).toHaveBeenCalledOnce()
  })

  it('start() aborts cleanly if stop() is called while pipeline.start() is pending', async () => {
    let resolvePipeline: () => void
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    pipelineHandle.start.mockImplementation(() => new Promise<void>(r => { resolvePipeline = r }))

    const { core } = makeCore()
    const p = core.start()
    core.stop()                 // stop before pipeline resolves
    resolvePipeline!()
    await p

    expect(core.getState()).toBe('IDLE')
    expect(core.isStarted()).toBe(false)
    expect(pipelineHandle.stop).toHaveBeenCalled()
  })

  it('start() emits error { code } when pipeline throws MicError', async () => {
    pipelineHandle.start.mockRejectedValueOnce(new MicErrorStub('MIC_DENIED', 'denied'))

    const { core, events } = makeCore()
    await core.start()

    expect(events.error).toHaveBeenCalledWith({ code: 'MIC_DENIED', message: 'denied' })
    expect(core.isStarted()).toBe(false)
    expect(core.getState()).toBe('IDLE')
  })

  it('start() emits AUDIO_CONTEXT_FAILED for non-MicError pipeline failures', async () => {
    pipelineHandle.start.mockRejectedValueOnce(new Error('weird'))

    const { core, events } = makeCore()
    await core.start()

    expect(events.error).toHaveBeenCalledWith({ code: 'AUDIO_CONTEXT_FAILED', message: expect.stringContaining('weird') })
  })

  it('stop() transitions back to IDLE and calls pipeline.stop', async () => {
    const { core, events } = makeCore()
    await core.start()
    core.stop()

    expect(pipelineHandle.stop).toHaveBeenCalled()
    expect(core.getState()).toBe('IDLE')
    expect(core.isStarted()).toBe(false)
    // last state-change is LISTENING → IDLE
    expect(events.stateChange.mock.calls.at(-1)?.[0]).toEqual({ from: 'LISTENING', to: 'IDLE' })
  })

  // ── Mute / unmute ────────────────────────────────────────────────────────

  it('mute() suspends the mic and flips state to MUTED', async () => {
    const { core, events } = makeCore()
    await core.start()

    core.mute()

    expect(pipelineHandle.setInputEnabled).toHaveBeenCalledWith(false)
    expect(core.getState()).toBe('MUTED')
    expect(events.muteChange).toHaveBeenCalledWith({ muted: true })
  })

  it('mute() is a no-op when not started', () => {
    const { core, events } = makeCore()
    core.mute()
    expect(pipelineHandle.setInputEnabled).not.toHaveBeenCalled()
    expect(events.muteChange).not.toHaveBeenCalled()
  })

  it('mute() is a no-op when already muted', async () => {
    const { core } = makeCore()
    await core.start()
    core.mute()
    pipelineHandle.setInputEnabled.mockClear()
    core.mute()
    expect(pipelineHandle.setInputEnabled).not.toHaveBeenCalled()
  })

  it('unmute() re-enables mic and returns to LISTENING', async () => {
    const { core, events } = makeCore()
    await core.start()
    core.mute()

    core.unmute()

    expect(pipelineHandle.setInputEnabled).toHaveBeenLastCalledWith(true)
    expect(core.getState()).toBe('LISTENING')
    expect(events.muteChange).toHaveBeenLastCalledWith({ muted: false })
  })

  it('unmute() is a no-op when not muted', async () => {
    const { core, events } = makeCore()
    await core.start()
    core.unmute()
    expect(pipelineHandle.setInputEnabled).not.toHaveBeenCalled()
    expect(events.muteChange).not.toHaveBeenCalled()
  })

  // ── Avatar signalling ────────────────────────────────────────────────────

  it('avatarSpeaking() only transitions from LISTENING', async () => {
    const { core } = makeCore()
    await core.start()

    core.avatarSpeaking()
    expect(core.getState()).toBe('AVATAR_SPEAKING')

    // Another call while AVATAR_SPEAKING is a no-op.
    core.avatarSpeaking()
    expect(core.getState()).toBe('AVATAR_SPEAKING')
  })

  it('avatarIdle() only transitions from AVATAR_SPEAKING', async () => {
    const { core } = makeCore()
    await core.start()

    core.avatarIdle()
    expect(core.getState()).toBe('LISTENING')  // no-op — was LISTENING

    core.avatarSpeaking()
    core.avatarIdle()
    expect(core.getState()).toBe('LISTENING')
  })

  // ── Worklet message routing ──────────────────────────────────────────────

  it('speech-start from LISTENING emits speech-start with a new sequenceId', async () => {
    const { core, events } = makeCore()
    await core.start()

    pipelineHandle.onMessage!({ type: 'speech-start' })

    expect(core.getState()).toBe('USER_SPEAKING')
    expect(events.speechStart).toHaveBeenCalledWith({ sequenceId: 1 })
    expect(events.bargeIn).not.toHaveBeenCalled()
  })

  it('speech-start during AVATAR_SPEAKING emits barge-in BEFORE speech-start', async () => {
    const { core, events } = makeCore()
    await core.start()
    core.avatarSpeaking()

    pipelineHandle.onMessage!({ type: 'speech-start' })

    expect(events.bargeIn).toHaveBeenCalledWith({ sequenceId: 1 })
    expect(events.speechStart).toHaveBeenCalledWith({ sequenceId: 1 })
    // barge-in happened first
    const bargeCallOrder  = events.bargeIn.mock.invocationCallOrder[0]
    const speechCallOrder = events.speechStart.mock.invocationCallOrder[0]
    expect(bargeCallOrder).toBeLessThan(speechCallOrder)
  })

  it('speech-start is ignored while MUTED or IDLE', async () => {
    const { core, events } = makeCore()
    await core.start()
    core.mute()

    pipelineHandle.onMessage!({ type: 'speech-start' })
    expect(events.speechStart).not.toHaveBeenCalled()
    expect(core.getState()).toBe('MUTED')
  })

  it('audio-chunk while USER_SPEAKING emits with matching sequenceId', async () => {
    const { core, events } = makeCore()
    await core.start()
    pipelineHandle.onMessage!({ type: 'speech-start' })

    const chunk = new Float32Array([0.1, 0.2]).buffer
    pipelineHandle.onMessage!({ type: 'audio-chunk', chunk })

    expect(events.audioChunk).toHaveBeenCalledOnce()
    const payload = events.audioChunk.mock.calls[0][0]
    expect(payload.chunk).toBe(chunk)
    expect(payload.sequenceId).toBe(1)
    expect(payload.timestamp).toBeTypeOf('number')
  })

  it('audio-chunk outside USER_SPEAKING is ignored', async () => {
    const { core, events } = makeCore()
    await core.start()

    pipelineHandle.onMessage!({ type: 'audio-chunk', chunk: new ArrayBuffer(4) })
    expect(events.audioChunk).not.toHaveBeenCalled()
  })

  it('speech-end emits utterance-audio (WAV blob) then speech-end, returns to LISTENING', async () => {
    const { core, events } = makeCore()
    await core.start()
    pipelineHandle.onMessage!({ type: 'speech-start' })
    pipelineHandle.onMessage!({ type: 'audio-chunk', chunk: new Float32Array([0.1, -0.1]).buffer })

    pipelineHandle.onMessage!({ type: 'speech-end' })

    expect(events.utterance).toHaveBeenCalledOnce()
    const ut = events.utterance.mock.calls[0][0]
    expect(ut.audio).toBeInstanceOf(Blob)
    expect(ut.audio.type).toBe('audio/wav')
    expect(ut.sequenceId).toBe(1)
    expect(ut.durationMs).toBeTypeOf('number')

    expect(events.speechEnd).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 1 }))
    expect(core.getState()).toBe('LISTENING')

    // utterance-audio emitted before speech-end
    expect(events.utterance.mock.invocationCallOrder[0])
      .toBeLessThan(events.speechEnd.mock.invocationCallOrder[0])
  })

  it('speech-end without any chunks skips utterance-audio but still emits speech-end', async () => {
    const { core, events } = makeCore()
    await core.start()
    pipelineHandle.onMessage!({ type: 'speech-start' })
    pipelineHandle.onMessage!({ type: 'speech-end' })

    expect(events.utterance).not.toHaveBeenCalled()
    expect(events.speechEnd).toHaveBeenCalledOnce()
  })

  it('increments sequenceId across successive utterances', async () => {
    const { core, events } = makeCore()
    await core.start()

    pipelineHandle.onMessage!({ type: 'speech-start' })
    pipelineHandle.onMessage!({ type: 'speech-end' })
    pipelineHandle.onMessage!({ type: 'speech-start' })
    pipelineHandle.onMessage!({ type: 'speech-end' })

    const ids = events.speechStart.mock.calls.map(c => c[0].sequenceId)
    expect(ids).toEqual([1, 2])
  })

  // ── Warn passthrough ─────────────────────────────────────────────────────

  it('forwards pipeline warnings to the warn event', async () => {
    const { core, events } = makeCore()
    await core.start()

    pipelineHandle.onWarn!('NOISE_SUPPRESSION_UNAVAILABLE', 'x')
    expect(events.warn).toHaveBeenCalledWith({
      code: 'NOISE_SUPPRESSION_UNAVAILABLE',
      message: 'x',
    })
  })

  // ── Config passthrough ───────────────────────────────────────────────────

  it('updateVadConfig() forwards to pipeline.updateConfig and mutates local config', async () => {
    const { core } = makeCore()
    await core.start()

    core.updateVadConfig({ vadThreshold: 0.82, minSpeechMs: 200 })

    expect(pipelineHandle.updateConfig).toHaveBeenCalledWith({
      vadThreshold: 0.82, minSpeechMs: 200,
    })
    expect(core.config.vadThreshold).toBe(0.82)
    expect(core.config.minSpeechMs).toBe(200)
  })

  it('resetNoiseFloor() forwards to the pipeline', async () => {
    const { core } = makeCore()
    await core.start()
    core.resetNoiseFloor()
    expect(pipelineHandle.resetNoiseFloor).toHaveBeenCalledOnce()
  })
})
