# Voxy

**Voice capture for conversational characters in the browser.** Voxy keeps
the microphone open, tells you when the player starts and stops speaking, hands
you the audio, and tells you the moment they talk over your character.

- **Always-on listening with pre-roll.** A short circular buffer means the first
  syllable is never clipped.
- **Silero VAD** in a Web Worker, fed by an AudioWorklet: inference never blocks
  the page or glitches the audio.
- **Noise handling**: an adaptive energy gate, plus optional RNNoise suppression
  in WebAssembly.
- **Barge-in**: one event the instant the player speaks while your character is
  talking, so you can stop playback.
- **A state machine you observe**, not drive: `state-change` moves between
  `IDLE`, `LISTENING`, `USER_SPEAKING`, `AVATAR_SPEAKING` and `MUTED`.

Voxy is how [Gameable Engine](https://github.com/getgameable/gameable-engine)
characters hear the player, and it works on its own in any web app.

## Install

```sh
npm install @gameable/voxy
```

## Use

```ts
import { VoxyCore } from '@gameable/voxy/core'
import modelUrl from '@gameable/voxy/models/silero_vad.onnx?url'
import noiseUrl from '@gameable/voxy/wasm/rnnoise.wasm?url'

const voxy = new VoxyCore({ modelUrl, noiseSuppressionUrl: noiseUrl })

voxy.on('speech-start', () => console.log('listening…'))
voxy.on('utterance-audio', ({ audio, durationMs }) => {
  // A complete utterance: send it to your transcription service.
})
voxy.on('barge-in', () => myCharacter.stopTalking())

await voxy.start() // asks for the microphone

// While your character talks, tell Voxy, so speech counts as a barge-in:
voxy.avatarSpeaking()
voxy.avatarIdle()
```

The `?url` imports are Vite's; with another bundler, serve `silero_vad.onnx`
and `rnnoise.wasm` from `node_modules/@gameable/voxy/dist/` and pass their URLs.
Without `noiseSuppressionUrl` reachable, Voxy runs without RNNoise; without the
model, it falls back to energy detection and emits a `warn`.

`@gameable/voxy` (the root) also exports DOM widgets — `VoxyWidget`, `Waveform`
and `MuteButton` — for a ready-made text box, mute toggle and level meter.
`@gameable/voxy/core` is the capture alone.

### Events

| Event             | Payload                                   |
| ----------------- | ----------------------------------------- |
| `state-change`    | `{ from, to }`                            |
| `speech-start`    | `{ sequenceId }`                          |
| `audio-chunk`     | `{ chunk, timestamp, sequenceId }`        |
| `speech-end`      | `{ durationMs, sequenceId }`              |
| `utterance-audio` | `{ audio: Blob, durationMs, sequenceId }` |
| `barge-in`        | `{ sequenceId }`                          |
| `mute-change`     | `{ muted }`                               |
| `text-submit`     | `{ text }`                                |
| `vad-frame`       | `{ prob, amplitude, noiseFloor, gated }`  |
| `warn`, `error`   | `{ code, message }`                       |

Tuning (`vadThreshold`, `silenceTimeoutMs`, `preRollMs`, `minSpeechMs`,
the energy gate) is in `VoxyConfig`; `updateVadConfig()` changes it live.

## Requirements

A browser with AudioWorklet, Web Workers and WebAssembly (every current
browser), and a secure context (HTTPS or localhost) for the microphone.

## Develop

```sh
npm install
npm run dev     # the dev UI: live VAD meters and every tuning knob
npm run check   # typecheck and tests
npm run build   # the library, into dist/
```

[Architecture](./docs/ARCHITECTURE.md) explains the threading model and the
state machine; [the requirements](./docs/PRD.md) explain why.

## Licence

MIT. The bundled Silero VAD model (MIT) and RNNoise binary (BSD-3-Clause) keep
their own licences; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
