/**
 * Shared test doubles for the Web Audio / MediaStream APIs.
 *
 * jsdom does not implement AudioContext, AudioWorkletNode, or
 * navigator.mediaDevices.getUserMedia. These stubs expose just enough
 * surface for the code under test to exercise its happy and error paths.
 */

import { vi } from 'vitest'

// ── Worklet port ────────────────────────────────────────────────────────────

/** A fake MessagePort that records postMessage calls and lets tests simulate
 *  messages coming the other way. */
export class MockPort {
  onmessage: ((e: MessageEvent) => void) | null = null
  readonly posted: Array<{ data: unknown; transfer?: Transferable[] }> = []
  private readonly listeners = new Set<(e: MessageEvent) => void>()
  started = false

  postMessage = vi.fn((data: unknown, transfer?: Transferable[]): void => {
    this.posted.push({ data, transfer })
  })

  addEventListener(_type: 'message', handler: (e: MessageEvent) => void): void {
    this.listeners.add(handler)
  }

  removeEventListener(_type: 'message', handler: (e: MessageEvent) => void): void {
    this.listeners.delete(handler)
  }

  start(): void { this.started = true }

  /** Test helper — fire a fake "main ← worklet" message. */
  emit(data: unknown): void {
    const event = { data } as MessageEvent
    this.onmessage?.(event)
    this.listeners.forEach(h => h(event))
  }
}

// ── AudioWorkletNode ────────────────────────────────────────────────────────

export class MockAudioWorkletNode {
  readonly port = new MockPort()
  disconnect = vi.fn()
}

// ── AudioContext ────────────────────────────────────────────────────────────

export interface MockAudioContextOptions {
  /** If true, context starts in 'suspended' state (start() must resume). */
  suspended?: boolean
  /** Force audioWorklet.addModule to reject with this error. */
  addModuleError?: unknown
}

export class MockAudioContext {
  state: AudioContextState = 'running'
  readonly sampleRate: number

  readonly audioWorklet = {
    addModule: vi.fn(async (_url: string): Promise<void> => {
      if (this._opts.addModuleError !== undefined) throw this._opts.addModuleError
    }),
  }

  resume = vi.fn(async (): Promise<void> => { this.state = 'running' })
  close  = vi.fn(async (): Promise<void> => { this.state = 'closed' })
  createMediaStreamSource = vi.fn((_stream: MediaStream) => ({
    connect:    vi.fn(),
    disconnect: vi.fn(),
  }))

  constructor(opts: { sampleRate?: number } & MockAudioContextOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16000
    if (opts.suspended) this.state = 'suspended'
    this._opts = opts
  }

  private readonly _opts: MockAudioContextOptions
}

// ── MediaStream ─────────────────────────────────────────────────────────────

export class MockMediaStreamTrack {
  enabled = true
  readonly stop = vi.fn()
}

export class MockMediaStream {
  readonly tracks: MockMediaStreamTrack[]

  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new MockMediaStreamTrack())
  }

  getTracks(): MockMediaStreamTrack[]      { return this.tracks }
  getAudioTracks(): MockMediaStreamTrack[] { return this.tracks }
}

// ── Install helpers ─────────────────────────────────────────────────────────

export interface AudioMockHandles {
  getUserMedia:           ReturnType<typeof vi.fn>
  contexts:               MockAudioContext[]
  workletNodes:           MockAudioWorkletNode[]
  streams:                MockMediaStream[]
  /** How many times `new AudioContext()` was called. */
  audioContextCtorCalls:  () => number
  /** How many times `new AudioWorkletNode()` was called. */
  workletNodeCtorCalls:   () => number
  /** Last args passed to `new AudioWorkletNode()`. */
  lastWorkletNodeArgs:    () => [unknown, string] | null
}

/**
 * Install mock constructors on the global scope so that
 * `new AudioContext()`, `new AudioWorkletNode()`, and
 * `navigator.mediaDevices.getUserMedia()` all return our doubles.
 *
 * Returns handles the test can inspect / manipulate. Call `restoreAudioMocks()`
 * in afterEach to avoid leaking between tests.
 */
export function installAudioMocks(options: {
  contextOptions?: MockAudioContextOptions & { sampleRate?: number }
  getUserMediaError?: unknown
} = {}): AudioMockHandles {
  const contexts:          MockAudioContext[] = []
  const workletNodes:      MockAudioWorkletNode[] = []
  const streams:           MockMediaStream[] = []
  const workletNodeArgs:   [unknown, string][] = []

  class AudioContextCtor {
    constructor(opts?: { sampleRate?: number }) {
      const ctx = new MockAudioContext({ ...options.contextOptions, ...opts })
      contexts.push(ctx)
      return ctx
    }
  }

  class AudioWorkletNodeCtor {
    constructor(ctx: unknown, name: string) {
      workletNodeArgs.push([ctx, name])
      const node = new MockAudioWorkletNode()
      workletNodes.push(node)
      return node
    }
  }

  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (options.getUserMediaError !== undefined) throw options.getUserMediaError
    const stream = new MockMediaStream()
    streams.push(stream)
    return stream
  })

  // @ts-expect-error — stubbing globals
  globalThis.AudioContext     = AudioContextCtor
  // @ts-expect-error — stubbing globals
  globalThis.AudioWorkletNode = AudioWorkletNodeCtor

  // navigator.mediaDevices may be undefined in jsdom — define it.
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })

  // URL.createObjectURL is not implemented in jsdom by default.
  if (!('createObjectURL' in URL)) {
    // @ts-expect-error — stubbing globals
    URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    // @ts-expect-error — stubbing globals
    URL.revokeObjectURL = vi.fn()
  }

  return {
    getUserMedia,
    contexts,
    workletNodes,
    streams,
    audioContextCtorCalls: () => contexts.length,
    workletNodeCtorCalls:  () => workletNodes.length,
    lastWorkletNodeArgs:   () => workletNodeArgs.at(-1) ?? null,
  }
}

export function restoreAudioMocks(): void {
  // @ts-expect-error — stubbing globals
  delete globalThis.AudioContext
  // @ts-expect-error — stubbing globals
  delete globalThis.AudioWorkletNode
  vi.unstubAllGlobals()
}
