import type { VoxyState } from '../types'

export const STATES: VoxyState[] = ['LISTENING', 'AVATAR_SPEAKING', 'USER_SPEAKING', 'MUTED']

export const STATE_LABELS: Record<VoxyState, string> = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  AVATAR_SPEAKING: 'AVATAR SPEAKING',
  USER_SPEAKING: 'USER SPEAKING',
  MUTED: 'MUTED',
}

export const STATE_DESCRIPTIONS: Partial<Record<VoxyState, string>> = {
  LISTENING: 'Mic open · VAD running',
  AVATAR_SPEAKING: 'Avatar playing · barge-in active',
  USER_SPEAKING: 'Speech detected · chunks streaming',
  MUTED: 'Mic suspended',
}

export default {
  STATES,
  STATE_LABELS,
  STATE_DESCRIPTIONS,
}