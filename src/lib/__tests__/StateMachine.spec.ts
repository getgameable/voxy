import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StateMachine } from '../StateMachine'
import type { VoxyState } from '@types'

describe('StateMachine', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('starts in IDLE', () => {
    expect(new StateMachine().getState()).toBe('IDLE')
  })

  it('returns the previous state on a successful transition', () => {
    const sm = new StateMachine()
    const prev = sm.transition('LISTENING')

    expect(prev).toBe('IDLE')
    expect(sm.getState()).toBe('LISTENING')
  })

  it('allows LISTENING → MUTED → LISTENING', () => {
    const sm = new StateMachine()
    sm.transition('LISTENING')
    expect(sm.transition('MUTED')).toBe('LISTENING')
    expect(sm.getState()).toBe('MUTED')
    expect(sm.transition('LISTENING')).toBe('MUTED')
    expect(sm.getState()).toBe('LISTENING')
  })

  it('allows barge-in: AVATAR_SPEAKING → USER_SPEAKING', () => {
    const sm = new StateMachine()
    sm.transition('LISTENING')
    sm.transition('AVATAR_SPEAKING')
    expect(sm.transition('USER_SPEAKING')).toBe('AVATAR_SPEAKING')
  })

  it('rejects invalid transitions, returns null, logs a warning and leaves state unchanged', () => {
    const sm = new StateMachine()
    // IDLE → MUTED is not allowed; IDLE only leads to LISTENING.
    const result = sm.transition('MUTED')

    expect(result).toBeNull()
    expect(sm.getState()).toBe('IDLE')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/Invalid transition: IDLE → MUTED/)
  })

  it('rejects self-transitions (no state loops)', () => {
    const sm = new StateMachine()
    sm.transition('LISTENING')
    expect(sm.transition('LISTENING')).toBeNull()
    expect(sm.getState()).toBe('LISTENING')
  })

  it('every non-IDLE state can return to IDLE (stop() path)', () => {
    const reachableFromListening: VoxyState[] = ['AVATAR_SPEAKING', 'USER_SPEAKING', 'MUTED']
    for (const s of reachableFromListening) {
      const sm = new StateMachine()
      sm.transition('LISTENING')
      sm.transition(s)
      expect(sm.transition('IDLE')).toBe(s)
    }
  })
})
