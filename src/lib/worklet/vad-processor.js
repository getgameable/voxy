// vad-processor — PCM frame pump with optional RNNoise denoising and
// downsampling to 16 kHz.
//
// Two-stage pipeline:
//   Stage 1 (optional): Accumulate 480 samples at native rate (48 kHz),
//     run RNNoise WASM to denoise, feed denoised samples to Stage 2.
//   Stage 2: Accumulate (512 × ratio) samples, decimate to 512-sample
//     frames at 16 kHz, transfer to main thread.
//
// If RNNoise is not initialised (WASM not provided or init failed),
// Stage 1 is bypassed and raw audio flows directly into Stage 2.
//
// Frames are transferred (zero-copy) to the main thread as raw ArrayBuffers.
// All VAD logic lives in VadEngine on the main thread.

const TARGET_RATE   = 16000
const FRAME_SIZE    = 512
const RNNOISE_FRAME = 480   // RNNoise requires exactly 480 samples at 48 kHz

// `sampleRate` is a global in AudioWorkletGlobalScope — the actual context rate.
const ratio        = Math.max(1, Math.round(sampleRate / TARGET_RATE))
const SRC_BUF_SIZE = FRAME_SIZE * ratio  // source samples needed per output frame

// ── Export mapping for @echogarden/rnnoise-wasm@0.2.0 ────────────────────────
// The WASM is compiled with Emscripten -O3 which minifies export names.
// These mappings are derived from the JS glue file (rnnoise.js).
const WASM_EXPORTS = {
  memory:                  'c',
  __wasm_call_ctors:       'd',
  rnnoise_get_frame_size:  'f',
  rnnoise_create:          'h',
  rnnoise_destroy:         'i',
  rnnoise_process_frame:   'k',
  malloc:                  'l',
  free:                    'j',
}

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    // ── RNNoise state ────────────────────────────────────────────────────────
    this.rnnoiseReady  = false
    this.rnn           = null    // mapped WASM exports { memory, create, process, malloc, ... }
    this.rnnoiseState  = 0       // pointer from rnnoise_create()
    this.inputPtr      = 0       // WASM heap pointer for input (480 floats)
    this.outputPtr     = 0       // WASM heap pointer for output (480 floats)

    // Ring buffer for accumulating 480 samples for RNNoise
    this.rnnBuf    = new Float32Array(RNNOISE_FRAME)
    this.rnnOffset = 0

    // ── Downsample state (fed with denoised or raw audio) ────────────────────
    this.srcBuf    = new Float32Array(SRC_BUF_SIZE)
    this.srcOffset = 0

    // Listen for WASM module from main thread
    this.port.onmessage = (e) => this._handleMessage(e)
  }

  _handleMessage(e) {
    if (e.data.type === 'init-rnnoise') {
      this._initRnnoise(e.data.wasmBytes)
    }
  }

  _initRnnoise(wasmBytes) {
    try {
      // Provide the two import stubs the Emscripten-compiled WASM expects.
      // a.a = emscripten_resize_heap — attempt to grow WASM memory
      // a.b = __emscripten_memcpy_js — fast memcpy via JS typed arrays
      let heapU8 = null  // lazily set after instantiation

      const importObject = {
        a: {
          a: function emscripten_resize_heap(requestedSize) {
            // Attempt to grow memory. Return 1 on success, 0 on failure.
            try {
              const memory = instance.exports[WASM_EXPORTS.memory]
              const oldSize = memory.buffer.byteLength
              const pages = ((requestedSize - oldSize + 65535) / 65536) | 0
              memory.grow(pages)
              heapU8 = new Uint8Array(memory.buffer)
              return 1
            } catch {
              return 0
            }
          },
          b: function __emscripten_memcpy_js(dest, src, num) {
            heapU8.copyWithin(dest, src, src + num)
          },
        },
      }

      // Synchronous compile+instantiate from raw bytes.
      var wasmModule = new WebAssembly.Module(wasmBytes)
      var instance = new WebAssembly.Instance(wasmModule, importObject)
      const raw = instance.exports

      // Initialise heap view
      const memory = raw[WASM_EXPORTS.memory]
      heapU8 = new Uint8Array(memory.buffer)

      // Call Emscripten constructor functions (required before any other export)
      raw[WASM_EXPORTS.__wasm_call_ctors]()

      // Build a friendly interface from the minified exports
      const rnn = {
        memory:       memory,
        create:       raw[WASM_EXPORTS.rnnoise_create],
        destroy:      raw[WASM_EXPORTS.rnnoise_destroy],
        processFrame: raw[WASM_EXPORTS.rnnoise_process_frame],
        getFrameSize: raw[WASM_EXPORTS.rnnoise_get_frame_size],
        malloc:       raw[WASM_EXPORTS.malloc],
        free:         raw[WASM_EXPORTS.free],
      }

      // Verify frame size matches expectation
      const frameSize = rnn.getFrameSize()
      if (frameSize !== RNNOISE_FRAME) {
        throw new Error(`RNNoise frame size mismatch: expected ${RNNOISE_FRAME}, got ${frameSize}`)
      }

      // Allocate denoiser state (pass 0/null for default model)
      const state = rnn.create(0)
      if (!state) throw new Error('rnnoise_create() returned null')

      // Allocate input/output buffers on WASM heap (480 × 4 bytes each)
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

  _denoiseFrame(input480) {
    const rnn       = this.rnn
    const heap      = new Float32Array(rnn.memory.buffer)
    const inOffset  = this.inputPtr >> 2   // byte offset → float32 index
    const outOffset = this.outputPtr >> 2

    // Copy input to WASM heap, scaling float [-1,1] → int16-range [-32768,32767]
    // (RNNoise expects samples in int16 amplitude range as floats)
    for (var i = 0; i < RNNOISE_FRAME; i++) {
      heap[inOffset + i] = input480[i] * 32768.0
    }

    // rnnoise_process_frame(state, output, input) → VAD probability (unused)
    rnn.processFrame(this.rnnoiseState, this.outputPtr, this.inputPtr)

    // Copy denoised output back, scaling int16-range → float [-1,1]
    // Re-acquire view in case memory grew during processing
    const denoised  = new Float32Array(RNNOISE_FRAME)
    const heapAfter = new Float32Array(rnn.memory.buffer)
    for (var i = 0; i < RNNOISE_FRAME; i++) {
      denoised[i] = heapAfter[outOffset + i] / 32768.0
    }

    return denoised
  }

  // Feed samples (denoised or raw) into the downsample ring buffer.
  // When enough accumulate, decimate to 16 kHz and send to main thread.
  _pushToDownsample(samples, length) {
    for (var i = 0; i < length; i++) {
      this.srcBuf[this.srcOffset++] = samples[i]

      if (this.srcOffset >= SRC_BUF_SIZE) {
        var frame = new Float32Array(FRAME_SIZE)

        if (ratio === 1) {
          frame.set(this.srcBuf)
        } else {
          for (var j = 0; j < FRAME_SIZE; j++) {
            var sum = 0
            var base = j * ratio
            for (var k = 0; k < ratio; k++) sum += this.srcBuf[base + k]
            frame[j] = sum / ratio
          }
        }

        this.port.postMessage({ type: 'frame', samples: frame.buffer }, [frame.buffer])
        this.srcBuf    = new Float32Array(SRC_BUF_SIZE)
        this.srcOffset = 0
      }
    }
  }

  process(inputs, _outputs, _params) {
    var ch = inputs[0]?.[0]
    if (!ch?.length) return true

    if (this.rnnoiseReady) {
      // ── RNNoise path: accumulate 480, denoise, then downsample ──────────
      for (var i = 0; i < ch.length; i++) {
        this.rnnBuf[this.rnnOffset++] = ch[i]

        if (this.rnnOffset >= RNNOISE_FRAME) {
          try {
            var denoised = this._denoiseFrame(this.rnnBuf)
            this._pushToDownsample(denoised, RNNOISE_FRAME)
          } catch (err) {
            // RNNoise crashed — fall back to passthrough for rest of session
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
      // ── Passthrough path: raw audio directly to downsample ──────────────
      this._pushToDownsample(ch, ch.length)
    }

    return true // keep processor alive
  }
}

registerProcessor('vad-processor', VadProcessor)
