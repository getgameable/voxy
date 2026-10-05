# Voxy — Architecture

## Overview

Voxy is a browser-native JavaScript library. It runs entirely within a single browser tab — no server-side audio processing, no native plugins. The core challenge it solves is running a neural network VAD model in real time against a live microphone stream without blocking the UI or causing audio glitches, while maintaining a coherent state machine that the consuming application can observe.

The repo contains two distinct things that must never be conflated:

| Concern | Location | Distributed? |
|---------|----------|--------------|
| The VAD library | `src/lib/` + `src/ui/` | Yes — ESM bundle |
| React dev/test UI | `src/dev-ui/` | No — dev server only |

---

## Browser Threading Model

The browser gives us three execution contexts. Each has a defined role in Voxy:

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser Tab                           │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                    Main Thread                        │   │
│  │                                                       │   │
│  │   VoxyCore          StateMachine       EventEmitter   │   │
│  │      │                   │                  │         │   │
│  │      └───────────────────┴──────────────────┘         │   │
│  │                          │                            │   │
│  │                     events out to consuming app       │   │
│  │                                                       │   │
│  │   AudioContext ──────────────────────────────────┐    │   │
│  └──────────────────────────────────────────────────┼────┘   │
│                                                     │        │
│                           mic stream                │        │
│                                                     ▼        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │               AudioWorklet Thread                    │    │
│  │            (dedicated audio thread)                  │    │
│  │                                                      │    │
│  │  • Receives raw PCM frames from mic                  │    │
│  │  • Assembles 512-sample chunks (30ms @ 16 kHz)       │    │
│  │  • Maintains pre-roll circular buffer                │    │
│  │  • Forwards frames to VAD Worker via MessagePort     │    │───┐
│  │  • Receives VAD probability back from Worker         │◄───┼─┐ │
│  │  • Flushes pre-roll + streams encoded chunks         │    │ │ │
│  │    when speech is active                             │    │ │ │
│  └──────────────────────────────────────────────────────┘    │ │ │
│                                                              │ │ │
│  ┌──────────────────────────────────────────────────────┐    │ │ │
│  │                  VAD Web Worker                      │    │ │ │
│  │             (dedicated worker thread)                │    │ │ │
│  │                                                      │    │ │ │
│  │  • Loads onnxruntime-web (WASM backend)              │    │ │ │
│  │  • Loads silero_vad.onnx model (~1.8 MB)             │    │ │ └─┤
│  │  • Runs inference per 30ms frame                     │    │ └───┤
│  │  • Maintains Silero recurrent hidden state           │    │     │
│  │  • Returns { probability, isSpeech } per frame       │    │     │
│  └──────────────────────────────────────────────────────┘    │     │
└──────────────────────────────────────────────────────────────┘     │
                                                                     │
         MessagePort (bidirectional, one per channel pair) ──────────┘
```

### Why this split?

- **AudioWorklet** runs on the browser's dedicated audio rendering thread, called at the hardware interrupt rate (~5ms). Putting inference here would risk audio glitches — the callback must return before the next interrupt.
- **Web Worker** is a general-purpose worker thread. ONNX Runtime Web loads and runs cleanly here. The WASM JIT and model memory are isolated from the UI thread.
- **Main thread** owns the state machine and public API. VAD results arrive here as messages (one event-loop hop, negligible latency for this purpose).

---

## Module Breakdown

### `src/lib/VoxyCore.ts`

The public-facing class. Consuming applications interact exclusively with this.

Responsibilities:
- Owns the `AudioContext` and coordinates startup/teardown
- Spawns the AudioWorklet and VAD Worker, wires up their `MessagePort`
- Delegates state transitions to `StateMachine`
- Exposes `avatarSpeaking()` / `avatarIdle()` for the consuming app to signal avatar turn
- Emits all public events via `EventEmitter`

### `src/lib/StateMachine.ts`

A simple explicit state machine — no external state library. Four states, defined transitions only (invalid transitions are no-ops with a `warn` log).

```
LISTENING ──────────────────────► AVATAR_SPEAKING   via avatarSpeaking()
AVATAR_SPEAKING ────────────────► LISTENING          via avatarIdle()
AVATAR_SPEAKING ────────────────► USER_SPEAKING      via VAD trigger  → emits barge-in
LISTENING ──────────────────────► USER_SPEAKING      via VAD trigger
USER_SPEAKING ──────────────────► LISTENING          via silence timeout
USER_SPEAKING ──────────────────► AVATAR_SPEAKING    via silence timeout (post-barge-in)
ANY ────────────────────────────► MUTED              via mute()
MUTED ──────────────────────────► LISTENING          via unmute()
```

`LISTENING` is the ground state. The mic is always open after `start()` — there is no inactive/idle state.

### `src/lib/VadEngine.ts`

Manages the VAD Worker lifecycle.

- Spawns the worker, sends the model URL for it to fetch
- Exposes a promise (`ready`) that resolves when the model is loaded
- Accepts frame buffers from the AudioWorklet (relayed via `VoxyCore`) and posts them to the worker
- Receives per-frame `{ probability }` responses and applies threshold logic with hysteresis:
  - Speech **starts** when probability ≥ `vadThreshold` (default 0.5)
  - Speech **ends** when probability < `vadEndThreshold` (default 0.35) for `silenceTimeoutMs` (default 800ms)
  - Separate start/end thresholds prevent rapid state flicker at the boundary

### `src/lib/AudioPipeline.ts`

Manages the AudioWorklet lifecycle.

- Creates the `MediaStreamSource` from `getUserMedia`
- Registers and instantiates the `AudioWorkletNode`
- Passes one end of a `MessageChannel` to the worklet at construction time
- Relays incoming encoded audio chunks to `VoxyCore` for event emission

### `src/lib/PreRollBuffer.ts`

A fixed-size circular buffer of raw PCM frames, running continuously inside the AudioWorklet regardless of VAD state. When VAD triggers, the buffer's contents are prepended to the outgoing audio stream before any new frames are appended.

Default size: 500ms of audio. Prevents the start of an utterance from being clipped when VAD lags the onset of speech by a frame or two.

### `src/lib/NoiseIsolation.ts`

Optional pre-filter applied in the AudioWorklet before frames are forwarded to the VAD Worker. Uses a WASM audio processing module (RNNoise or equivalent) to attenuate background noise, reducing false-positive VAD triggers in noisy environments.

Loaded lazily. If the WASM module fails to load, the pipeline continues without it and emits a `warn` event (`NOISE_SUPPRESSION_UNAVAILABLE`). The VAD Engine then operates on unfiltered audio.

### `src/lib/EventEmitter.ts`

A typed event bus. All events are strongly typed against a shared `VoxyEvents` interface. No external dependency.

### `src/ui/`

Vanilla DOM widget — no framework. Mounts into any selector the consuming app provides. Contains:

- **`ListeningIndicator`** — animated element reflecting current state. Always visible; text changes between "Listening…" and "Muted" based on mic state.
- **`MuteButton`** — toggles `voxy.mute()` / `voxy.unmute()`. This is the only audio control exposed in the UI. There is no start/stop button — always-on listening is the product default.
- **`TextInput`** — text field + submit button; emits `text-submit` event on Enter or click.

---

## Silero VAD

### What it is

Silero VAD is a lightweight recurrent neural network trained for speech detection, distributed as an ONNX file. ONNX (Open Neural Network Exchange) is a portable model format; ONNX Runtime Web is the JavaScript/WASM runtime that executes it in the browser. No WASM code needs to be written — `onnxruntime-web` is the WASM layer.

### Frame contract

| Parameter | Value | Reason |
|-----------|-------|--------|
| Sample rate | 16 kHz | Silero's expected input; also optimal for most STT engines |
| Frame size | 512 samples | 32ms per frame — Silero's design unit |
| Input shape | `[1, 512]` | Single channel, one frame |
| Hidden state | `[2, 1, 64]` | Carried between frames; must be preserved across calls |
| Output | scalar float | Speech probability 0–1 |

The hidden state is the critical detail: Silero is not stateless. The worker must hold the `h` and `c` tensors between inference calls and feed them back in with each frame. Resetting hidden state when a new utterance sequence begins is necessary to avoid state bleed between turns.

### Inference location

Inference runs in the **VAD Web Worker**, not the AudioWorklet. The sequence per frame is:

```
AudioWorklet → postMessage(float32Frame) → VAD Worker
VAD Worker   → ort.InferenceSession.run({ input, h, c })
             → update h, c
             → postMessage({ probability })
VAD Worker   → main thread (via VadEngine relay)
             → threshold check → state machine event
```

### Model loading

The Silero ONNX model is fetched at runtime from a configurable URL (`modelUrl` option). It is not bundled into the ESM output — the model file is ~1.8 MB and would bloat the importable library significantly. Consuming apps should host it on their own CDN or static server.

---

## Audio Pipeline in Detail

```
getUserMedia({ audio: true, sampleRate: 16000 })
        │
        ▼
  MediaStreamSource
        │
        ▼
  AudioWorkletNode  ◄──── vad-processor.js (runs on audio thread)
        │
        │  Inside the worklet, per 128-sample hardware callback:
        │  1. Accumulate samples into 512-sample frame buffer
        │  2. Write frame into pre-roll circular buffer
        │  3. Post frame to VAD Worker via MessagePort
        │  4. Receive VAD result (async, previous frame's result)
        │  5. If speech active:
        │       - If first frame: flush pre-roll buffer first
        │       - Encode frame (PCM or Opus)
        │       - Post encoded chunk to main thread
        │
        ▼
  Main Thread (VoxyCore)
        │
        ├── On VAD start → StateMachine transition → 'speech-start' event
        ├── On audio-chunk → 'audio-chunk' event (sequenceId, ArrayBuffer)
        └── On silence timeout → 'speech-end' event (sequenceId, durationMs)
```

### sequenceId

Each continuous utterance is assigned a monotonically increasing `sequenceId`. All `audio-chunk` events and the closing `speech-end` event for a given utterance share the same ID. The consuming app uses this to correlate chunks when routing to a transcription microservice.

---

## Startup Sequence

```
voxy.start()
  │
  ├─ 1. getUserMedia()                     // mic permission
  ├─ 2. new AudioContext({ sampleRate: 16000 })
  │
  ├─ 3. [parallel]
  │     ├─ Spawn VAD Worker
  │     │    └─ fetch(modelUrl) → load silero_vad.onnx
  │     │    └─ ort.InferenceSession.create(model)
  │     │    └─ post 'ready'
  │     │
  │     └─ audioContext.audioWorklet.addModule('vad-processor.js')
  │
  ├─ 4. Create MessageChannel
  │     ├─ port1 → AudioWorkletNode (via node.port)
  │     └─ port2 → VAD Worker (via worker.postMessage, transfer)
  │
  ├─ 5. Connect: MediaStreamSource → AudioWorkletNode → AudioContext.destination
  │
  └─ 6. State → LISTENING
         └─ emit 'state-change' ({ from: null, to: 'LISTENING' })
```

Steps 3a and 3b are parallelised. The model fetch + WASM JIT compile is the dominant startup cost (typically 200–800ms depending on network and device).

---

## Build Configuration

Vite is configured for two outputs from the same source tree:

| Mode | Command | Entry | Output |
|------|---------|-------|--------|
| Library | `npm run build` | `src/lib/index.ts` | `dist/voxy.es.js` + `dist/voxy.d.ts` |
| Dev server | `npm run dev` | `index.html` → `src/dev-ui/App.tsx` | Served at `localhost:5173` |

The AudioWorklet processor script (`vad-processor.js`) must be a separate file — it cannot be inlined into the ESM bundle because `audioWorklet.addModule()` requires a URL. It is emitted as a separate asset during the library build and is expected to be hosted alongside the main bundle.

---

## Key Constraints and Decisions

**Always-on microphone.** The mic opens when `voxy.start()` is called and stays open. The user's only control is mute/unmute. This is intentional — combined with the pre-roll buffer, it ensures the start of every utterance is captured.

**No external state library.** The state machine is a hand-written switch/guard structure. The state space is small and fixed; a library like XState would add weight without meaningful benefit.

**No framework in the library.** `src/lib/` and `src/ui/` have zero React (or other framework) dependencies. The React dev UI in `src/dev-ui/` is a development tool only.

**ONNX Runtime Web as a peer concern.** `onnxruntime-web` is not bundled into the library output. Consuming apps must either include it themselves or point Voxy at a CDN copy via configuration. This keeps the distributable lean.

**Noise suppression is optional.** Silero handles mild noise well on its own. The WASM noise suppression layer is opt-in (`noiseSuppression: true` in config) and degrades gracefully — if the WASM module fails, the pipeline continues without it.
