# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (React dev UI at localhost:5173)
npm run build     # Type-check (tsc -b) then build library + dev UI
npm run lint      # Run ESLint
npm run preview   # Preview production build locally
```

There is no test runner configured yet.

## What Voxy is

Voxy is a browser-importable JavaScript library for voice activity detection (VAD) in AI avatar conversation interfaces. The repo has two distinct concerns that must stay separated:

1. **The distributable library** (`src/lib/`) — framework-agnostic ESM, no React, no framework deps. This is what consuming applications import.
2. **The React dev UI** (`src/dev-ui/`) — a Vite/React test harness for developing and visualising the library. Never included in the distributed bundle.

The full product spec is in `PRD.md`.

## Architecture

### Source structure (target layout)

```
src/
├── lib/              # Distributable library — keep React-free
│   ├── VoxyCore.ts           # Main class; owns lifecycle and public API
│   ├── StateMachine.ts       # Conversation state machine
│   ├── AudioPipeline.ts      # Mic capture, pre-roll buffer, encoding, chunk emission
│   ├── VadEngine.ts          # Silero VAD via ONNX Runtime Web (AudioWorklet)
│   ├── NoiseIsolation.ts     # Optional WASM noise suppression (RNNoise or similar)
│   ├── PreRollBuffer.ts      # Circular buffer — retains audio before VAD trigger
│   ├── EventEmitter.ts       # Typed event bus
│   └── index.ts              # Public API re-exports
├── ui/               # Mountable vanilla DOM widget (no framework)
│   ├── VoxyWidget.ts
│   ├── TextInput.ts
│   ├── MuteButton.ts         # Mute/unmute — NOT a start/stop button
│   └── ListeningIndicator.ts
└── dev-ui/            # React test harness only — not distributed
    ├── App.tsx
    ├── StateMachineViz.tsx
    ├── AudioMonitor.tsx
    └── EventLog.tsx
```

### State machine

The mic is **always on** after `voxy.start()`. These are the four states:

| State | Meaning |
|-------|---------|
| `LISTENING` | Default/ground state — mic open, VAD running, no active speech |
| `AVATAR_SPEAKING` | Avatar audio playing; VAD still active for barge-in |
| `USER_SPEAKING` | VAD triggered — pre-roll flushed, chunks streaming to consumer |
| `MUTED` | User muted — mic suspended |

The consuming app signals avatar state via `voxy.avatarSpeaking()` / `voxy.avatarIdle()`. Voxy signals user speech state via events.

### Audio pipeline

```
getUserMedia → NoiseIsolation (WASM, optional) → AudioWorklet
  → Silero VAD (ONNX, 30ms frames @ 16kHz)
  → Pre-roll circular buffer (default 500ms)
  → [on VAD trigger] flush pre-roll + stream encoded chunks → 'audio-chunk' events
  → [on silence timeout] → 'speech-end' event
```

Key design points:
- **Pre-roll buffer** prevents clipped sentence starts — audio captured before the VAD trigger is prepended to the outgoing stream
- **Streaming chunks** (not buffered full utterances) are the primary output — downstream transcription starts immediately
- Each utterance has a `sequenceId` shared across its `audio-chunk` and `speech-end` events so the consumer can correlate them
- Silero VAD uses separate start/end thresholds (hysteresis) to prevent rapid state flicker

### Key events emitted

```typescript
'state-change'   // { from, to }
'barge-in'       // user spoke during AVATAR_SPEAKING — consumer must pause playback
'speech-start'   // VAD triggered, pre-roll flushed
'audio-chunk'    // { chunk: ArrayBuffer, timestamp, sequenceId } — streaming
'speech-end'     // { durationMs, sequenceId } — silence timeout elapsed
'text-submit'    // { text } — user submitted text input
'mute-change'    // { muted }
'warn'           // { code, message } — non-fatal (e.g. VAD_FALLBACK, NOISE_SUPPRESSION_UNAVAILABLE)
'error'          // { code, message } — fatal
```

### Build outputs

Vite is configured for dual output:
- **Library mode** → `dist/voxy.es.js` + `dist/voxy.d.ts` (entry: `src/lib/index.ts`)
- **Dev server** → serves `index.html` / `src/dev-ui/App.tsx` (React test harness)

### Toolchain notes

- **React Compiler** (`babel-plugin-react-compiler`) is active — manual `useMemo`/`useCallback` is unnecessary in `dev-ui/`
- **TypeScript** strict mode; project references: `tsconfig.app.json` (src), `tsconfig.node.json` (build tooling)
- **ESLint** flat config (`eslint.config.js`) with TypeScript, React Hooks, React Refresh rules
- ONNX Runtime Web and Silero model are fetched at runtime via configurable URLs — not bundled — to keep bundle size manageable
