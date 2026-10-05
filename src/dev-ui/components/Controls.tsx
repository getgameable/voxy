import { useState } from 'react'
import type { IVoxyCore, VoxyState } from '@types'

interface VadConfig {
  vadThreshold?: number
  vadEndThreshold?: number
  silenceTimeoutMs?: number
  minSpeechMs?: number
  energyGateEnabled?: boolean
  energyGateMult?: number
}

interface Props {
  voxy: IVoxyCore
  state: VoxyState
  avatarSim: boolean
  noiseFloor: number
  onAvatarSpeaking: () => void
  onAvatarIdle: () => void
  onPlayTestAudio: () => void
  onConfigChange: (config: VadConfig) => void
  onResetNoiseFloor: () => void
  initialConfig: { vadThreshold: number; vadEndThreshold: number; silenceTimeoutMs: number; minSpeechMs: number; energyGateEnabled: boolean; energyGateMult: number }
}

export function Controls({ voxy, state, avatarSim, noiseFloor, onAvatarSpeaking, onAvatarIdle, onPlayTestAudio, onConfigChange, onResetNoiseFloor, initialConfig }: Props) {
  const [vadStart, setVadStart] = useState(initialConfig.vadThreshold)
  const [vadEnd, setVadEnd] = useState(initialConfig.vadEndThreshold)
  const [silenceTimeout, setSilenceTimeout] = useState(initialConfig.silenceTimeoutMs)
  const [minSpeech, setMinSpeech] = useState(initialConfig.minSpeechMs)
  const [gateEnabled, setGateEnabled] = useState(initialConfig.energyGateEnabled)
  const [gateMult, setGateMult] = useState(initialConfig.energyGateMult)

  const isStarted = voxy.isStarted()
  const isIdle = state === 'IDLE'
  const isMuted = state === 'MUTED'

  return (
    <section className="panel controls-panel">
      <h2 className="panel-title">Controls</h2>

      <div className="control-group">
        <h3 className="control-group__title">Lifecycle</h3>
        <div className="button-row">
          <button
            className="btn btn--primary"
            onClick={() => voxy.start()}
            disabled={isStarted}
          >
            Start
          </button>
          <button
            className="btn btn--danger"
            onClick={() => voxy.stop()}
            disabled={isIdle}
          >
            Stop
          </button>
        </div>
      </div>

      <div className="control-group">
        <h3 className="control-group__title">Avatar Signals</h3>
        <div className="button-row">
          <button
            className="btn"
            onClick={onAvatarSpeaking}
            disabled={avatarSim || isMuted}
            title="Plays sine tone + signals avatarSpeaking() if in LISTENING"
          >
            Avatar Speaking
          </button>
          <button
            className="btn"
            onClick={onAvatarIdle}
            disabled={!avatarSim}
            title="Stops tone + signals avatarIdle() if in AVATAR_SPEAKING"
          >
            Avatar Idle
          </button>
          <button
            className="btn"
            onClick={onPlayTestAudio}
            disabled={avatarSim || isIdle}
            title="Decodes and plays public/test-audio/energyDrinks-myra.pcm through speakers"
          >
            Play Test Audio
          </button>
        </div>
      </div>

      <div className="control-group">
        <h3 className="control-group__title">Mute</h3>
        <div className="button-row">
          <button
            className="btn"
            onClick={() => voxy.mute()}
            disabled={!isStarted || isMuted}
          >
            Mute
          </button>
          <button
            className="btn"
            onClick={() => voxy.unmute()}
            disabled={!isMuted}
          >
            Unmute
          </button>
        </div>
      </div>

      <div className="control-group control-group--sliders">
        <h3 className="control-group__title">
          VAD Config
          <span className="control-group__note"> — speech probability 0–1</span>
        </h3>

        <label className="slider-label">
          <span className="slider-label__name">Start threshold</span>
          <span className="slider-label__value">{vadStart.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.0} max={1.0} step={0.01}
          value={vadStart}
          onChange={e => {
            const v = Number(e.target.value)
            setVadStart(v)
            onConfigChange({ vadThreshold: v })
          }}
          className="slider"
        />

        <label className="slider-label">
          <span className="slider-label__name">End threshold</span>
          <span className="slider-label__value">{vadEnd.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.0} max={1.0} step={0.01}
          value={vadEnd}
          onChange={e => {
            const v = Number(e.target.value)
            setVadEnd(v)
            onConfigChange({ vadEndThreshold: v })
          }}
          className="slider"
        />

        <label className="slider-label">
          <span className="slider-label__name">Silence timeout</span>
          <span className="slider-label__value">{silenceTimeout} ms</span>
        </label>
        <input
          type="range"
          min={200} max={2000} step={50}
          value={silenceTimeout}
          onChange={e => {
            const v = Number(e.target.value)
            setSilenceTimeout(v)
            onConfigChange({ silenceTimeoutMs: v })
          }}
          className="slider"
        />

        <label className="slider-label">
          <span className="slider-label__name">Min speech duration</span>
          <span className="slider-label__value">{minSpeech} ms</span>
        </label>
        <input
          type="range"
          min={0} max={2000} step={50}
          value={minSpeech}
          onChange={e => {
            const v = Number(e.target.value)
            setMinSpeech(v)
            onConfigChange({ minSpeechMs: v })
          }}
          className="slider"
        />
      </div>

      <div className="control-group control-group--sliders">
        <h3 className="control-group__title">
          Energy Gate
          <span className="control-group__note"> — adaptive noise floor</span>
        </h3>

        <label className="slider-label">
          <span className="slider-label__name">Enabled</span>
          <span className="slider-label__value">{gateEnabled ? 'ON' : 'OFF'}</span>
        </label>
        <input
          type="checkbox"
          checked={gateEnabled}
          onChange={e => {
            const v = e.target.checked
            setGateEnabled(v)
            onConfigChange({ energyGateEnabled: v })
          }}
          className="checkbox"
        />

        <label className="slider-label">
          <span className="slider-label__name">Gate multiplier</span>
          <span className="slider-label__value">{gateMult.toFixed(1)}x</span>
        </label>
        <input
          type="range"
          min={1.0} max={6.0} step={0.1}
          value={gateMult}
          disabled={!gateEnabled}
          onChange={e => {
            const v = Number(e.target.value)
            setGateMult(v)
            onConfigChange({ energyGateMult: v })
          }}
          className="slider"
        />

        <div className="slider-label">
          <span className="slider-label__name">Noise floor (RMS)</span>
          <span className="slider-label__value">{noiseFloor.toFixed(5)}</span>
        </div>
        <div className="slider-label">
          <span className="slider-label__name">Gate threshold</span>
          <span className="slider-label__value">{(noiseFloor * gateMult).toFixed(5)}</span>
        </div>

        <div className="button-row" style={{ marginTop: '0.5rem' }}>
          <button
            className="btn btn--ghost"
            onClick={onResetNoiseFloor}
            disabled={!isStarted}
            title="Re-calibrate the noise floor from scratch"
          >
            Re-calibrate
          </button>
        </div>
      </div>
    </section>
  )
}
