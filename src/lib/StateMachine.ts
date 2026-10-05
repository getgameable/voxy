import type { VoxyState } from './types'

// Valid transitions. AVATAR_SPEAKING / USER_SPEAKING transitions are included
// for the VAD phase; guarded by the pipeline being ready.
const VALID: Partial<Record<VoxyState, ReadonlySet<VoxyState>>> = {
  IDLE:            new Set(['LISTENING']),
  LISTENING:       new Set(['MUTED', 'AVATAR_SPEAKING', 'USER_SPEAKING', 'IDLE']),
  AVATAR_SPEAKING: new Set(['LISTENING', 'MUTED', 'USER_SPEAKING', 'IDLE']),
  USER_SPEAKING:   new Set(['LISTENING', 'AVATAR_SPEAKING', 'MUTED', 'IDLE']),
  MUTED:           new Set(['LISTENING', 'IDLE']),
}

export class StateMachine {
  private current: VoxyState = 'IDLE'

  getState(): VoxyState {
    return this.current
  }

  /**
   * Attempt a transition. Returns the previous state on success, or null if
   * the transition is invalid (logs a console warning).
   */
  transition(to: VoxyState): VoxyState | null {
    const allowed = VALID[this.current]
    if (!allowed?.has(to)) {
      console.warn(`[Voxy] Invalid transition: ${this.current} → ${to}`)
      return null
    }
    const prev = this.current
    this.current = to
    return prev
  }
}
