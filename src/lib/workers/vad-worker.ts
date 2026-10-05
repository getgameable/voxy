/**
 * vad-worker — Web Worker running Silero VAD via ONNX Runtime Web.
 *
 * Supports both Silero model interfaces automatically:
 *   - Legacy (v4):  inputs { input, sr, h, c }  → outputs { output, hn, cn }
 *   - Current:      inputs { input, sr, state }  → outputs { output, stateN }
 *
 * Message protocol
 * ─────────────────
 * Main → Worker:
 *   { type: 'init', modelUrl: string }
 *   { type: 'frame', samples: ArrayBuffer }   ← transferred (zero-copy)
 *   { type: 'reset-state' }
 *
 * Worker → Main:
 *   { type: 'ready' }
 *   { type: 'prob', value: number }            ← speech probability 0–1
 *   { type: 'error', message: string, during: 'init' | 'inference' }
 */

import * as ort from 'onnxruntime-web'

// ── WASM paths ────────────────────────────────────────────────────────────────
// Point to CDN so the WASM blobs are not bundled. Must be set before any
// InferenceSession is created.
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/'

// ── State ─────────────────────────────────────────────────────────────────────

let session: ort.InferenceSession | null = null

// Derived from the model after load — do not assume a fixed size.
let hiddenSize = 64              // last dim of h/c or state tensor
let stateH = new Float32Array(2 * hiddenSize)
let stateC = new Float32Array(2 * hiddenSize)

// Set after session loads — determined from session.inputNames
let usesCombinedState = false // true = 'state' input; false = 'h'+'c' inputs

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; modelUrl?: string; samples?: ArrayBuffer }

  switch (msg.type) {
    case 'init':
      await handleInit(msg.modelUrl!)
      break

    case 'frame':
      handleFrame(msg.samples!)
      break

    case 'reset-state':
      stateH = new Float32Array(2 * hiddenSize)
      stateC = new Float32Array(2 * hiddenSize)
      break
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function handleInit(modelUrl: string): Promise<void> {
  try {
    // Fetch explicitly so a missing/404 file gives a clear error message
    // rather than "protobuf parsing failed" from ONNX Runtime.
    const response = await fetch(modelUrl)
    if (!response.ok) {
      throw new Error(`Model fetch failed: ${response.status} ${response.statusText} (${modelUrl})`)
    }
    const modelBuffer = await response.arrayBuffer()

    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
    })

    // Detect which state interface this model uses.
    // Legacy (separate h/c) uses hiddenSize=64; combined state uses hiddenSize=128.
    usesCombinedState = session.inputNames.includes('state')
    hiddenSize = usesCombinedState ? 128 : 64

    stateH = new Float32Array(2 * hiddenSize)  // zero-initialised by spec
    stateC = new Float32Array(2 * hiddenSize)

    self.postMessage({ type: 'ready' })
  } catch (err) {
    self.postMessage({ type: 'error', during: 'init', message: String(err) })
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────

function handleFrame(samples: ArrayBuffer): void {
  if (!session) {
    self.postMessage({ type: 'error', during: 'inference', message: 'Session not initialised' })
    return
  }

  try {
    const pcm = new Float32Array(samples)
    const inputTensor = new ort.Tensor('float32', pcm, [1, 512])
    const srTensor    = new ort.Tensor('int64',   new BigInt64Array([16000n]), [1])

    let feeds: Record<string, ort.Tensor>

    if (usesCombinedState) {
      // Current Silero interface: single 'state' tensor of shape [2, 1, hiddenSize]
      const stateBuf = new Float32Array(2 * hiddenSize)
      stateBuf.set(stateH.subarray(0, hiddenSize))
      stateBuf.set(stateC.subarray(0, hiddenSize), hiddenSize)
      feeds = {
        input: inputTensor,
        sr:    srTensor,
        state: new ort.Tensor('float32', stateBuf, [2, 1, hiddenSize]),
      }
    } else {
      // Legacy Silero interface: separate 'h' and 'c' tensors, each [2, 1, hiddenSize]
      feeds = {
        input: inputTensor,
        sr:    srTensor,
        h:     new ort.Tensor('float32', stateH.slice(0), [2, 1, hiddenSize]),
        c:     new ort.Tensor('float32', stateC.slice(0), [2, 1, hiddenSize]),
      }
    }

    session.run(feeds)
      .then((outputs) => {
        // Update LSTM state for the next frame.
        if (usesCombinedState) {
          const stateOut = outputs['stateN'].data as Float32Array
          stateH.set(stateOut.subarray(0, hiddenSize))
          stateC.set(stateOut.subarray(hiddenSize))
        } else {
          stateH.set(outputs['hn'].data as Float32Array)
          stateC.set(outputs['cn'].data as Float32Array)
        }

        const prob = (outputs['output'].data as Float32Array)[0]
        self.postMessage({ type: 'prob', value: prob })
      })
      .catch((err: unknown) => {
        self.postMessage({ type: 'error', during: 'inference', message: String(err) })
      })
  } catch (err) {
    self.postMessage({ type: 'error', during: 'inference', message: String(err) })
  }
}
