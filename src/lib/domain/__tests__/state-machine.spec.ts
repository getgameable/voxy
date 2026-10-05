import { describe, it, expect } from 'vitest'
import { STATES, STATE_LABELS, STATE_DESCRIPTIONS } from '../state-machine'
import type { VoxyState } from '@types'

describe('domain/state-machine constants', () => {
  it('STATES excludes IDLE (UI-facing list of operational states only)', () => {
    expect(STATES).not.toContain<VoxyState>('IDLE')
    expect(STATES).toEqual(['LISTENING', 'AVATAR_SPEAKING', 'USER_SPEAKING', 'MUTED'])
  })

  it('STATE_LABELS has an entry for every VoxyState including IDLE', () => {
    const expected: VoxyState[] = ['IDLE', ...STATES]
    for (const s of expected) {
      expect(STATE_LABELS[s]).toBeTypeOf('string')
      expect(STATE_LABELS[s].length).toBeGreaterThan(0)
    }
  })

  it('STATE_DESCRIPTIONS covers every operational state', () => {
    for (const s of STATES) {
      expect(STATE_DESCRIPTIONS[s]).toBeTypeOf('string')
    }
  })

  it('STATE_DESCRIPTIONS does not define IDLE (idle has no UI description)', () => {
    expect(STATE_DESCRIPTIONS.IDLE).toBeUndefined()
  })
})
