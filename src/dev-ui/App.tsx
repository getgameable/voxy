import { useEffect, useRef, useState } from 'react'

import type { VoxyState, StateChangePayload, UtteranceAudioPayload } from '@types'

import { VoxyCore } from '@lib'
import { VoxyWidget } from '@ui'
import { StateMachineViz } from './components/StateMachineViz'
import { Controls } from './components/Controls'
import { EventLog, type LogEntry } from './components/EventLog'
import { RecordingLog, type Recording } from './components/RecordingLog'
import { AudioMonitor } from './components/AudioMonitor'

import './App.scss'

let nextId = 0

function timestamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export default function App() {
  const voxyRef = useRef<VoxyCore | null>(null)
  if (voxyRef.current === null) voxyRef.current = new VoxyCore()
  const voxy = voxyRef.current

  const widgetContainerRef = useRef<HTMLDivElement>(null)

  const [state, setState] = useState<VoxyState>('IDLE')
  const [lastTransition, setLastTransition] = useState<StateChangePayload | null>(null)
  const [events, setEvents] = useState<LogEntry[]>([])
  const [recordings, setRecordings] = useState<Recording[]>([])

  // Tracks whether the avatar sim tone is playing. Decoupled from VoxyCore
  // state so the buttons work regardless of whether start() has been called.
  const [avatarSim, setAvatarSim] = useState(false)
  const [noiseFloor, setNoiseFloor] = useState(0)

  // Test audio playback refs — no state needed, just lifecycle tracking.
  const testAudioPlayingRef = useRef(false)
  const testAudioSourceRef  = useRef<AudioBufferSourceNode | null>(null)
  const testAudioContextRef = useRef<AudioContext | null>(null)

  function stopTestAudio() {
    try { testAudioSourceRef.current?.stop() } catch { /* already stopped */ }
    testAudioSourceRef.current  = null
    testAudioContextRef.current?.close().catch(() => {})
    testAudioContextRef.current = null
    testAudioPlayingRef.current = false
  }

  function pushEvent(event: string, payload: Record<string, unknown>) {
    setEvents(prev => [...prev, { id: nextId++, timestamp: timestamp(), event, payload }])
  }

  // Subscribe to all VoxyCore events
  useEffect(() => {
    const handleStateChange = (p: StateChangePayload) => {
      setState(p.to)
      setLastTransition(p)
      pushEvent('state-change', p as unknown as Record<string, unknown>)
    }

    const handleUtteranceAudio = ({ audio, sequenceId, durationMs }: UtteranceAudioPayload) => {
      const url = URL.createObjectURL(audio)
      setRecordings(prev => [...prev, { sequenceId, url, durationMs, createdAt: Date.now() }])
      pushEvent('utterance-audio', { sequenceId, durationMs, bytes: audio.size })
    }

    // Throttle noise floor updates to avoid re-rendering every 32ms frame
    let lastNoiseFloorUpdate = 0
    const handleVadFrame = ({ noiseFloor: nf }: { noiseFloor: number }) => {
      const now = performance.now()
      if (now - lastNoiseFloorUpdate > 250) {
        lastNoiseFloorUpdate = now
        setNoiseFloor(nf)
      }
    }

    voxy.on('state-change', handleStateChange)
    voxy.on('barge-in', p => pushEvent('barge-in', p as unknown as Record<string, unknown>))
    voxy.on('speech-start', p => pushEvent('speech-start', p as unknown as Record<string, unknown>))
    voxy.on('audio-chunk', p => pushEvent('audio-chunk', p as unknown as Record<string, unknown>))
    voxy.on('speech-end', p => pushEvent('speech-end', p as unknown as Record<string, unknown>))
    voxy.on('utterance-audio', handleUtteranceAudio)
    voxy.on('mute-change', p => pushEvent('mute-change', p as unknown as Record<string, unknown>))
    voxy.on('text-submit', p => pushEvent('text-submit', p as unknown as Record<string, unknown>))
    voxy.on('warn', p => pushEvent('warn', p as unknown as Record<string, unknown>))
    voxy.on('error', p => pushEvent('error', p as unknown as Record<string, unknown>))
    voxy.on('vad-frame', handleVadFrame)

    return () => {
      voxy.off('state-change', handleStateChange)
      voxy.off('utterance-audio', handleUtteranceAudio)
      voxy.off('vad-frame', handleVadFrame)
    }
  }, [voxy])

  // When barge-in fires (USER_SPEAKING while avatarSim is active), stop the sim.
  useEffect(() => {
    if (avatarSim && state === 'USER_SPEAKING') {
      stopTestAudio()
      setAvatarSim(false)
    }
  }, [state, avatarSim])

  // Sine-wave tone for the duration of the avatar sim (skipped when test audio is playing)
  useEffect(() => {
    if (!avatarSim || testAudioPlayingRef.current) return

    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.value = 220 // A3 — clearly audible, not grating
    gain.gain.value = 0

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()

    // Fade in over 40 ms to avoid click
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.04)

    return () => {
      // Fade out over 60 ms, then stop
      const t = ctx.currentTime
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0, t + 0.06)
      osc.stop(t + 0.08)
      ctx.close()
    }
  }, [avatarSim])

  const handleAvatarSpeaking = () => {
    setAvatarSim(true)
    voxy.avatarSpeaking() // transitions LISTENING → AVATAR_SPEAKING; no-op otherwise
  }

  const handleAvatarIdle = () => {
    setAvatarSim(false)
    voxy.avatarIdle() // transitions AVATAR_SPEAKING → LISTENING; no-op otherwise
  }

  const handlePlayTestAudio = async () => {
    try {
      const response = await fetch('/test-audio/energyDrinks-myra.pcm')
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
      const raw     = await response.arrayBuffer()
      const int16   = new Int16Array(raw)
      const float32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

      const ctx    = new AudioContext()
      const buffer = ctx.createBuffer(1, float32.length, 24_000) // Int16 mono 24 kHz PCM
      buffer.copyToChannel(float32, 0)

      const source  = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)

      testAudioPlayingRef.current = true
      testAudioSourceRef.current  = source
      testAudioContextRef.current = ctx

      setAvatarSim(true)
      voxy.avatarSpeaking()

      source.onended = () => {
        stopTestAudio()
        setAvatarSim(false)
        voxy.avatarIdle()
      }

      source.start()
    } catch (err) {
      pushEvent('error', { code: 'TEST_AUDIO_FAILED', message: String(err) })
    }
  }

  // Mount VoxyWidget into the preview container
  useEffect(() => {
    if (!widgetContainerRef.current) return
    const widget = new VoxyWidget(voxy, widgetContainerRef.current)
    return () => widget.destroy()
  }, [voxy])

  return (
    <div className="dev-ui">
      <header className="dev-ui__header">
        <span className="dev-ui__title">Voxy Dev UI</span>
        <span className="dev-ui__badge">live</span>
      </header>
      <main className="dev-ui__body">
        <aside className="dev-ui__left">
          <StateMachineViz state={state} lastTransition={lastTransition} />
          <Controls
            voxy={voxy}
            state={state}
            avatarSim={avatarSim}
            noiseFloor={noiseFloor}
            onAvatarSpeaking={handleAvatarSpeaking}
            onAvatarIdle={handleAvatarIdle}
            onPlayTestAudio={handlePlayTestAudio}
            onConfigChange={(c) => voxy.updateVadConfig(c)}
            onResetNoiseFloor={() => voxy.resetNoiseFloor()}
            initialConfig={{
              vadThreshold:     voxy.config.vadThreshold,
              vadEndThreshold:  voxy.config.vadEndThreshold,
              silenceTimeoutMs: voxy.config.silenceTimeoutMs,
              minSpeechMs:      voxy.config.minSpeechMs,
              energyGateEnabled: voxy.config.energyGateEnabled,
              energyGateMult:    voxy.config.energyGateMult,
            }}
          />
        </aside>
        <div className="dev-ui__right">
          <div className="dev-ui__widget-slot" ref={widgetContainerRef} />
          <EventLog events={events} onClear={() => setEvents([])} />
          <AudioMonitor voxy={voxy} />
          <RecordingLog
            recordings={recordings}
            onClear={() => {
              recordings.forEach(r => URL.revokeObjectURL(r.url))
              setRecordings([])
            }}
          />
        </div>
      </main>
    </div>
  )
}
