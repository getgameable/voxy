import type { VoxyState, VoxyEventMap } from '@types'

type Handler<T> = (payload: T) => void

export class VoxyMock {
  private listeners = new Map<string, Set<Handler<unknown>>>()
  private state: VoxyState = 'IDLE'
  private preMuteState: VoxyState = 'IDLE'
  private sequenceId = 0
  private chunkInterval: ReturnType<typeof setInterval> | null = null
  private speechStartTime: number | null = null
  private started = false

  // ── EventEmitter ─────────────────────────────────────────────────────────

  on<K extends keyof VoxyEventMap>(event: K, handler: Handler<VoxyEventMap[K]>): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler as Handler<unknown>)
  }

  off<K extends keyof VoxyEventMap>(event: K, handler: Handler<VoxyEventMap[K]>): void {
    this.listeners.get(event)?.delete(handler as Handler<unknown>)
  }

  private emit<K extends keyof VoxyEventMap>(event: K, payload: VoxyEventMap[K]): void {
    this.listeners.get(event)?.forEach(h => h(payload as unknown))
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  getState(): VoxyState {
    return this.state
  }

  isStarted(): boolean {
    return this.started
  }

  private transition(to: VoxyState): void {
    const from = this.state
    this.state = to
    this.emit('state-change', { from, to })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.emit('warn', { code: 'MOCK', message: 'VoxyMock: mic access simulated' })
    this.transition('LISTENING')
  }

  stop(): void {
    this._clearChunkInterval()
    this.started = false
    const from = this.state
    this.state = 'IDLE'
    this.emit('state-change', { from, to: 'IDLE' })
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  mute(): void {
    if (this.state === 'MUTED') return
    this.preMuteState = this.state
    this._clearChunkInterval()
    this.transition('MUTED')
    this.emit('mute-change', { muted: true })
  }

  unmute(): void {
    if (this.state !== 'MUTED') return
    this.transition(this.preMuteState === 'IDLE' ? 'LISTENING' : this.preMuteState)
    this.emit('mute-change', { muted: false })
  }

  // ── Avatar signalling ─────────────────────────────────────────────────────

  avatarSpeaking(): void {
    if (this.state !== 'LISTENING') return
    this.transition('AVATAR_SPEAKING')
  }

  avatarIdle(): void {
    if (this.state !== 'AVATAR_SPEAKING') return
    this.transition('LISTENING')
  }

  // ── Simulation helpers ────────────────────────────────────────────────────

  simulateSpeechStart(): void {
    if (!this.started || this.state === 'MUTED' || this.state === 'USER_SPEAKING') return
    const isBargeIn = this.state === 'AVATAR_SPEAKING'
    const seq = ++this.sequenceId
    if (isBargeIn) {
      this.emit('barge-in', { sequenceId: seq })
    }
    this.transition('USER_SPEAKING')
    this.emit('speech-start', { sequenceId: seq })
    this.speechStartTime = Date.now()
    this.chunkInterval = setInterval(() => {
      this.emit('audio-chunk', {
        chunk: new ArrayBuffer(640),
        timestamp: Date.now(),
        sequenceId: seq,
      })
    }, 100)
  }

  simulateSpeechEnd(): void {
    if (this.state !== 'USER_SPEAKING') return
    this._clearChunkInterval()
    const durationMs = this.speechStartTime ? Date.now() - this.speechStartTime : 0
    this.speechStartTime = null
    this.emit('speech-end', { durationMs, sequenceId: this.sequenceId })
    this.transition('LISTENING')
  }

  simulateWarn(code = 'VAD_FALLBACK', message = 'Energy-based VAD active'): void {
    this.emit('warn', { code, message })
  }

  simulateError(code = 'MIC_DENIED', message = 'Microphone access denied'): void {
    this.emit('error', { code, message })
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _clearChunkInterval(): void {
    if (this.chunkInterval !== null) {
      clearInterval(this.chunkInterval)
      this.chunkInterval = null
    }
  }
}
