// @ts-nocheck — AudioWorklet runs in its own JS context with unique globals
// (AudioWorkletProcessor, registerProcessor, sampleRate). Not exposed by the standard DOM lib.

/**
 * vad-processor — PCM frame pump with optional RNNoise denoising and
 * downsampling to 16 kHz.
 *
 * Two-stage pipeline:
 *   Stage 1 (optional): Accumulate 480 samples at native rate (48 kHz),
 *     run RNNoise WASM to denoise, feed denoised samples to Stage 2.
 *   Stage 2: Accumulate (512 × ratio) samples, decimate to 512-sample
 *     frames at 16 kHz, transfer to main thread.
 *
 * If RNNoise is not initialised (WASM not provided or init failed),
 * Stage 1 is bypassed and raw audio flows directly into Stage 2.
 *
 * Frames are transferred (zero-copy) to the main thread as raw ArrayBuffers.
 * All VAD logic lives in VadEngine on the main thread.
 */

const TARGET_RATE   = 16_000
const FRAME_SIZE    = 512
const RNNOISE_FRAME = 480

const ratio        = Math.max(1, Math.round(sampleRate / TARGET_RATE))
const SRC_BUF_SIZE = FRAME_SIZE * ratio

// Export mapping for @echogarden/rnnoise-wasm@0.2.0 (Emscripten -O3 minified)
const WASM_EXPORTS = {
  memory:                  'c',
  __wasm_call_ctors:       'd',
  rnnoise_get_frame_size:  'f',
  rnnoise_create:          'h',
  rnnoise_destroy:         'i',
  rnnoise_process_frame:   'k',
  malloc:                  'l',
  free:                    'j',
} as const

interface RNNoiseAPI {
  memory:       WebAssembly.Memory
  create:       (model: number) => number
  destroy:      (state: number) => void
  processFrame: (state: number, output: number, input: number) => number
  getFrameSize: () => number
  malloc:       (bytes: number) => number
  free:         (ptr: number) => void
}

class VadProcessor extends AudioWorkletProcessor {
  private rnnoiseReady = false
  private rnn: RNNoiseAPI | null = null
  private rnnoiseState = 0
  private inputPtr     = 0
  private outputPtr    = 0

  private rnnBuf    = new Float32Array(RNNOISE_FRAME)
  private rnnOffset = 0

  private srcBuf: Float32Array = new Float32Array(SRC_BUF_SIZE)
  private srcOffset = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => this._handleMessage(e)
  }

  private _handleMessage(e: MessageEvent): void {
    if (e.data.type === 'init-rnnoise') {
      this._initRnnoise(e.data.wasmBytes as ArrayBuffer)
    }
  }

  private _initRnnoise(wasmBytes: ArrayBuffer): void {
    try {
      let heapU8: Uint8Array | null = null

      const importObject = {
        a: {
          a(requestedSize: number): number {
            try {
              const memory = instance.exports[WASM_EXPORTS.memory] as WebAssembly.Memory
              const oldSize = memory.buffer.byteLength
              const pages = ((requestedSize - oldSize + 65535) / 65536) | 0
              memory.grow(pages)
              heapU8 = new Uint8Array(memory.buffer)
              return 1
            } catch {
              return 0
            }
          },
          b(dest: number, src: number, num: number): void {
            heapU8!.copyWithin(dest, src, src + num)
          },
        },
      }

      const wasmModule = new WebAssembly.Module(wasmBytes)
      // eslint-disable-next-line no-var
      var instance = new WebAssembly.Instance(wasmModule, importObject)
      const raw = instance.exports

      const memory = raw[WASM_EXPORTS.memory] as WebAssembly.Memory
      heapU8 = new Uint8Array(memory.buffer)

      ;(raw[WASM_EXPORTS.__wasm_call_ctors] as () => void)()

      const rnn: RNNoiseAPI = {
        memory,
        create:       raw[WASM_EXPORTS.rnnoise_create] as (m: number) => number,
        destroy:      raw[WASM_EXPORTS.rnnoise_destroy] as (s: number) => void,
        processFrame: raw[WASM_EXPORTS.rnnoise_process_frame] as (s: number, o: number, i: number) => number,
        getFrameSize: raw[WASM_EXPORTS.rnnoise_get_frame_size] as () => number,
        malloc:       raw[WASM_EXPORTS.malloc] as (n: number) => number,
        free:         raw[WASM_EXPORTS.free] as (p: number) => void,
      }

      const frameSize = rnn.getFrameSize()
      if (frameSize !== RNNOISE_FRAME) {
        throw new Error(`RNNoise frame size mismatch: expected ${RNNOISE_FRAME}, got ${frameSize}`)
      }

      const state = rnn.create(0)
      if (!state) throw new Error('rnnoise_create() returned null')

      const bytesNeeded = RNNOISE_FRAME * 4
      const inputPtr  = rnn.malloc(bytesNeeded)
      const outputPtr = rnn.malloc(bytesNeeded)
      if (!inputPtr || !outputPtr) throw new Error('malloc failed for RNNoise buffers')

      this.rnn          = rnn
      this.rnnoiseState = state
      this.inputPtr     = inputPtr
      this.outputPtr    = outputPtr
      this.rnnoiseReady = true

      this.port.postMessage({ type: 'rnnoise-ready' })
    } catch (err) {
      this.port.postMessage({ type: 'rnnoise-error', message: String(err) })
    }
  }

  private _denoiseFrame(input480: Float32Array): Float32Array {
    const rnn       = this.rnn!
    const heap      = new Float32Array(rnn.memory.buffer)
    const inOffset  = this.inputPtr >> 2
    const outOffset = this.outputPtr >> 2

    for (let i = 0; i < RNNOISE_FRAME; i++) {
      heap[inOffset + i] = input480[i] * 32768.0
    }

    rnn.processFrame(this.rnnoiseState, this.outputPtr, this.inputPtr)

    const denoised  = new Float32Array(RNNOISE_FRAME)
    const heapAfter = new Float32Array(rnn.memory.buffer)
    for (let i = 0; i < RNNOISE_FRAME; i++) {
      denoised[i] = heapAfter[outOffset + i] / 32768.0
    }

    return denoised
  }

  private _pushToDownsample(samples: Float32Array, length: number): void {
    for (let i = 0; i < length; i++) {
      this.srcBuf[this.srcOffset++] = samples[i]

      if (this.srcOffset >= SRC_BUF_SIZE) {
        const frame = new Float32Array(FRAME_SIZE)

        if (ratio === 1) {
          frame.set(this.srcBuf)
        } else {
          for (let j = 0; j < FRAME_SIZE; j++) {
            let sum = 0
            const base = j * ratio
            for (let k = 0; k < ratio; k++) sum += this.srcBuf[base + k]
            frame[j] = sum / ratio
          }
        }

        this.port.postMessage({ type: 'frame', samples: frame.buffer }, [frame.buffer])
        this.srcBuf    = new Float32Array(SRC_BUF_SIZE)
        this.srcOffset = 0
      }
    }
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _params: Record<string, Float32Array>): boolean {
    const ch = inputs[0]?.[0]
    if (!ch?.length) return true

    if (this.rnnoiseReady) {
      for (let i = 0; i < ch.length; i++) {
        this.rnnBuf[this.rnnOffset++] = ch[i]

        if (this.rnnOffset >= RNNOISE_FRAME) {
          try {
            const denoised = this._denoiseFrame(this.rnnBuf)
            this._pushToDownsample(denoised, RNNOISE_FRAME)
          } catch {
            this.rnnoiseReady = false
            this._pushToDownsample(this.rnnBuf, RNNOISE_FRAME)
            this.port.postMessage({
              type: 'rnnoise-error',
              message: 'RNNoise runtime error — falling back to passthrough',
            })
          }
          this.rnnBuf    = new Float32Array(RNNOISE_FRAME)
          this.rnnOffset = 0
        }
      }
    } else {
      this._pushToDownsample(ch, ch.length)
    }

    return true
  }
}

registerProcessor('vad-processor', VadProcessor)
