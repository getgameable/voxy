# Voxy — Product Requirements Document

## Overview

Voxy is a browser-importable JavaScript library that provides voice activity detection (VAD) and a text input widget for AI avatar conversation interfaces. It sits between the user's microphone and a consuming application (the avatar host), managing audio capture, noise isolation, barge-in detection, and audio streaming to a transcription microservice. A React/Vite dev UI is bundled in the same repo as a test harness — it is not part of the distributable library.

---

## Problem Statement

AI avatar applications need to know:
1. When a user starts and stops speaking (so audio can be streamed to a transcription microservice in real time)
2. When a user speaks *while* the avatar is speaking (barge-in / interruption), so playback can be paused immediately
3. How to accept text input as an alternative to voice
4. How to do all of the above without missing the start of utterances — the microphone must always be hot

These concerns are cross-cutting across avatar products. Voxy centralises them into a single embeddable library.

---

## Goals

- Ship a framework-agnostic ESM library consumable via `import` in any browser application
- **Always-on listening** — the microphone is open and running continuously by default; the user mutes rather than activating
- **Pre-roll buffering** — maintain a short circular audio buffer so that audio captured just before VAD fires is included, preventing clipped sentence starts
- **Streaming audio chunks** — emit audio to the consuming app in real time during a user utterance so the transcription microservice can begin processing immediately
- Implement a state machine that models the conversation turn — the library drives state, the consuming app observes it via events
- Detect voice activity using the Silero VAD model; use a WASM-based audio isolation layer if required for noise suppression
- Emit a barge-in event the moment user voice is detected while the avatar is speaking, so the consuming app can halt playback
- Provide a mountable UI widget (text input + mute toggle + listening indicator)
- Provide a React dev UI (same repo, not distributed) for visualising the state machine and testing the pipeline end-to-end

## Non-Goals

- Transcription — Voxy streams audio out; transcription happens downstream in a separate microservice
- LLM routing — outside this library's scope
- Avatar rendering — Voxy emits events; the avatar host handles rendering
- Mobile / native — browser only (Web Audio API, `getUserMedia`)

---

## Architecture

### Repository layout (target)

```
voxy/
├── src/
│   ├── lib/                      # Distributable library (no React deps)
│   │   ├── VoxyCore.ts           # Main instantiable class
│   │   ├── StateMachine.ts       # Conversation state machine
│   │   ├── AudioPipeline.ts      # Mic capture, pre-roll buffer, encoding, chunk emission
│   │   ├── VadEngine.ts          # Silero VAD wrapper (ONNX Runtime Web / AudioWorklet)
│   │   ├── NoiseIsolation.ts     # WASM-based audio isolation (RNNoise or similar)
│   │   ├── PreRollBuffer.ts      # Circular buffer — retains N ms before VAD trigger
│   │   ├── EventEmitter.ts       # Typed event bus
│   │   └── index.ts              # Public API re-exports
│   ├── ui/                       # Mountable vanilla UI widget (no React)
│   │   ├── VoxyWidget.ts         # Widget shell — mounts into a DOM node
│   │   ├── TextInput.ts          # Text input component
│   │   ├── MuteButton.ts         # Mute/unmute toggle (always-on by default)
│   │   └── ListeningIndicator.ts # Animated "Listening…" status
│   └── dev-ui/                    # React dev/test harness (not distributed)
│       ├── App.tsx
│       ├── StateMachineViz.tsx
│       ├── AudioMonitor.tsx      # Waveform + VAD probability score
│       └── EventLog.tsx
├── public/
├── index.html                    # Dev UI entry
├── vite.config.ts                # Dev server + library build config
└── package.json
```

### Two build outputs

| Output | Entry | Description |
|--------|-------|-------------|
| `dist/voxy.es.js` | `src/lib/index.ts` | ESM library — what consuming apps import |
| Dev server | `index.html` / `src/dev-ui/App.tsx` | React test UI, not shipped |

Vite's library mode produces the ESM bundle; the dev server runs the React harness.

---

## State Machine

The state machine is the single source of truth for conversation turn. **Listening is the default and ground state** — the mic is always open unless explicitly muted.

### States

| State | Description |
|-------|-------------|
| `LISTENING` | Mic is open, VAD is running, no active speech detected |
| `AVATAR_SPEAKING` | Avatar audio is playing; VAD remains active for barge-in detection |
| `USER_SPEAKING` | VAD detected active speech; pre-roll flushed, audio chunks streaming |
| `MUTED` | User muted; mic stream suspended, no VAD processing |

`PROCESSING` is not a discrete state — because audio is streamed in chunks during `USER_SPEAKING`, the consuming app's transcription microservice processes in real time. The transition back to `LISTENING` (or `AVATAR_SPEAKING`) is triggered by the silence timeout, not by downstream processing completing.

### Transitions

```
LISTENING ──────────────────────► AVATAR_SPEAKING   (consuming app: avatarSpeaking())
AVATAR_SPEAKING ────────────────► LISTENING          (consuming app: avatarIdle())
AVATAR_SPEAKING ────────────────► USER_SPEAKING      (VAD trigger → barge-in emitted)
LISTENING ──────────────────────► USER_SPEAKING      (VAD trigger)
USER_SPEAKING ──────────────────► LISTENING          (silence timeout → speech-end emitted)
USER_SPEAKING ──────────────────► AVATAR_SPEAKING    (silence timeout while avatar was interrupted)
ANY ────────────────────────────► MUTED              (user mutes)
MUTED ──────────────────────────► LISTENING          (user unmutes)
```

### Barge-in

When a transition from `AVATAR_SPEAKING` → `USER_SPEAKING` occurs, Voxy emits `barge-in` synchronously before completing the transition. The consuming app must pause avatar playback in response — Voxy does not control avatar audio directly.

---

## Audio Pipeline

```
getUserMedia()
    │
    ▼
AudioContext / MediaStreamSource
    │
    ├──► NoiseIsolation (WASM — RNNoise or equivalent)  [optional, configurable]
    │
    ▼
AudioWorklet (VAD + pre-roll)
    │  ├── Silero VAD model (ONNX Runtime Web, runs per 30ms frame)
    │  └── Pre-roll circular buffer (configurable, default 500ms)
    │
    ├── VAD inactive: frames discarded (only pre-roll retained)
    │
    └── VAD active (USER_SPEAKING):
            │
            ▼
        Pre-roll buffer flush → prepended to stream
            │
            ▼
        Encoder (Opus via WebCodecs; fallback: raw PCM Float32)
            │
            ▼
        'audio-chunk' events → consuming app → transcription microservice
            │
        Silence timeout elapsed:
            ▼
        'speech-end' event (final chunk + duration)
```

### Pre-roll buffer

A short circular buffer (default 500 ms, configurable) runs continuously in the AudioWorklet regardless of VAD state. When VAD transitions to active, the contents of this buffer are prepended to the outgoing audio stream before new frames are appended. This ensures the start of an utterance — which may predate the VAD trigger by one or two frames — is never clipped.

### VAD Engine — Silero

- **Model:** [Silero VAD](https://github.com/snakers4/silero-vad) — small (< 2 MB), runs entirely in-browser via ONNX Runtime Web in an AudioWorklet
- **Frame size:** 30 ms (512 samples @ 16 kHz), matching Silero's expected input
- **Output:** per-frame speech probability (0–1) compared against `vadThreshold` (default 0.5)
- **Hysteresis:** separate `vadStartThreshold` (default 0.5) and `vadEndThreshold` (default 0.35) to reduce flicker at the boundary
- **Fallback:** energy-based RMS VAD if ONNX Runtime fails to load; emits `warn` event with code `VAD_FALLBACK`

### Noise Isolation

- **Optional WASM layer:** RNNoise (or equivalent) run in a SharedArrayBuffer-backed WASM module, applied before the VAD frame to reduce false positives in noisy environments
- Toggled via `noiseSuppression` config option (default `true`)
- If WASM fails to load, pipeline continues without it; emits `warn` event with code `NOISE_SUPPRESSION_UNAVAILABLE`

---

## Public API

### Instantiation

```typescript
import { Voxy } from 'voxy';

const voxy = new Voxy({
  // VAD
  vadThreshold: 0.5,           // Silero speech probability to enter USER_SPEAKING
  vadEndThreshold: 0.35,       // Silero speech probability to exit USER_SPEAKING (hysteresis)
  silenceTimeoutMs: 800,       // ms of sub-threshold frames before speech-end
  preRollMs: 500,              // ms of audio retained before VAD trigger

  // Audio
  sampleRate: 16000,           // 16 kHz — optimised for STT
  noiseSuppression: true,      // enable WASM noise isolation layer

  // Model
  modelUrl: '/models/silero_vad.onnx',  // path or URL to Silero ONNX model
});
```

### Mounting the widget

```typescript
voxy.mount('#voxy-container');   // injects UI into selector
voxy.unmount();
```

### Lifecycle

```typescript
await voxy.start();   // requests mic permission, opens AudioContext, enters LISTENING
voxy.mute();          // → MUTED
voxy.unmute();        // → LISTENING
voxy.stop();          // closes mic, halts AudioContext
voxy.destroy();       // stop + unmount + remove all listeners
```

### Consuming app → Voxy (avatar state signals)

```typescript
voxy.avatarSpeaking();   // → AVATAR_SPEAKING
voxy.avatarIdle();       // → LISTENING (or previous non-avatar state)
```

### Events (Voxy → consuming app)

```typescript
voxy.on('state-change',  ({ from, to }: StateChangeEvent) => { });

// Barge-in — emit immediately when user speaks during avatar turn
voxy.on('barge-in',      () => { pauseAvatarPlayback(); });

voxy.on('speech-start',  () => { /* pre-roll flushed, chunks incoming */ });

// Streaming audio — emitted continuously during USER_SPEAKING
voxy.on('audio-chunk',   ({ chunk: ArrayBuffer, timestamp: number, sequenceId: number }) => {
  sendToTranscriptionService(chunk);
});

// End of utterance — emitted on silence timeout
voxy.on('speech-end',    ({ durationMs: number, sequenceId: number }) => {
  // sequenceId matches the chunks emitted during this utterance
  finaliseTranscription(sequenceId);
});

voxy.on('text-submit',   ({ text: string }) => { sendToLLM(text); });

voxy.on('mute-change',   ({ muted: boolean }) => { });

voxy.on('warn',          ({ code: string, message: string }) => { });
voxy.on('error',         ({ code: string, message: string }) => { });
```

### Error / warn codes

| Code | Type | Description |
|------|------|-------------|
| `MIC_DENIED` | error | User denied microphone permission |
| `MIC_UNAVAILABLE` | error | No input device found |
| `AUDIO_CONTEXT_FAILED` | error | AudioContext could not be created |
| `VAD_LOAD_FAILED` | error | Silero ONNX model failed to load and fallback also failed |
| `VAD_FALLBACK` | warn | ONNX unavailable; using energy-based VAD |
| `NOISE_SUPPRESSION_UNAVAILABLE` | warn | WASM noise isolation failed to load; continuing without it |

---

## UI Widget

The mountable widget provides:

- **Text input field** — submits on Enter or send button; emits `text-submit`
- **"Listening…" indicator** — animated visual shown whenever state is `LISTENING` or `AVATAR_SPEAKING`; communicates to the user that the mic is always open
- **Mute toggle** — mutes / unmutes the mic; does not stop the AudioContext. When muted, indicator changes to "Muted"

There is no "start listening" button — the microphone is always on after `voxy.start()` is called. Muting is the only user-facing way to suppress audio capture.

The widget is implemented as vanilla DOM (no framework) so it has zero dependency overhead for consuming apps.

---

## React Dev UI

Runs only in the Vite dev server. Not included in the distributed bundle.

Panels:
- **State Machine Visualiser** — live state graph with last transition and timestamp
- **Audio Monitor** — real-time waveform, VAD probability score per frame, pre-roll buffer fill level
- **Chunk Log** — list of emitted `audio-chunk` events with sequence ID, size, and timestamp
- **Event Log** — timestamped stream of all emitted events
- **Controls** — manually trigger `avatarSpeaking()` / `avatarIdle()`, mute/unmute, adjust VAD threshold and silence timeout sliders

---

## Distribution

- Package name: `voxy`
- Main export: `dist/voxy.es.js` (ESM, tree-shakeable)
- Types: `dist/voxy.d.ts`
- ONNX Runtime Web is a peer dependency (or loaded from CDN); the Silero model is fetched from a configurable URL at runtime (not bundled, to keep bundle size manageable)
- WASM noise suppression module fetched at runtime from a configurable URL

---

## Open Questions

1. **Transcription microservice transport** — does the consuming app send chunks over WebSocket or accumulate and POST? Doesn't affect Voxy's output format, but worth aligning on so the `sequenceId` scheme is useful.
2. **Noise suppression module** — RNNoise WASM (~100 KB) vs. a heavier model (Krisp-style); depends on target noise environment. Can be swapped via the `noiseSuppressionUrl` config option without changing the API.
3. **ONNX Runtime Web hosting** — bundle in the ESM output or expect the consuming app to have it available as a peer? Bundling adds ~1 MB gzipped.
4. **Pre-roll duration tuning** — 500 ms is a reasonable default but may need adjusting based on real-world VAD trigger latency with Silero. Should be surfaced in the dev UI for easy experimentation.
5. **Barge-in sensitivity** — should the `vadThreshold` during `AVATAR_SPEAKING` be different (higher, to reduce false positives from avatar audio bleed) or the same as during `LISTENING`? May need a separate `bargeInThreshold` config option.
