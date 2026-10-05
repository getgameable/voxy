/**
 * Export-map contract test for `public/wasm/rnnoise.wasm`.
 *
 * The AudioWorklet runs in a context that cannot import npm packages. To keep
 * the bundle small and avoid shipping the Emscripten runtime, `vad-processor`
 * instantiates a standalone RNNoise WASM build and calls into its minified
 * exports directly (`c` = memory, `h` = rnnoise_create, …).
 *
 * If the WASM is ever rebuilt with different optimisation flags, Emscripten
 * version, or export list, those single-letter names will shift and silently
 * break noise suppression at runtime. This spec instantiates the real file
 * and asserts:
 *   1. every letter listed in WASM_EXPORTS still exists, and
 *   2. calling through them behaves like RNNoise (get_frame_size returns 480,
 *      create/destroy round-trip, one frame of silence denoises without error).
 *
 * When this breaks: rebuild the WASM and update the WASM_EXPORTS map in
 * src/lib/worklet/vad-processor.ts — the rest of the worklet code doesn't need
 * to change. See public/wasm/README.md for the build command.
 */

/// <reference types="node" />
import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Mirror of the mapping in src/lib/worklet/vad-processor.ts
// Intentionally duplicated so a mismatch in the worklet is caught here too.
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

const RNNOISE_FRAME = 480
const HERE = dirname(fileURLToPath(import.meta.url))
const WASM_PATH = resolve(HERE, '../../../../public/wasm/rnnoise.wasm')

// Tiny import object matching what vad-processor.ts provides — enough for
// instantiation + memory growth calls Emscripten might make.
function makeImports(getInstance: () => WebAssembly.Instance | null) {
  const getMemory = () =>
    getInstance()?.exports[WASM_EXPORTS.memory] as WebAssembly.Memory | undefined
  return {
    a: {
      a(requestedSize: number): number {
        const memory = getMemory()
        if (!memory) return 0
        try {
          const oldSize = memory.buffer.byteLength
          const pages   = ((requestedSize - oldSize + 65535) / 65536) | 0
          memory.grow(pages)
          return 1
        } catch {
          return 0
        }
      },
      b(dest: number, src: number, num: number): void {
        const memory = getMemory()
        if (!memory) return
        // Re-view memory each call — the underlying ArrayBuffer may have been
        // replaced by a memory.grow() since the last import call.
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num)
      },
    },
  }
}

describe('RNNoise WASM export contract', () => {
  let instance: WebAssembly.Instance

  beforeAll(async () => {
    const bytes = await readFile(WASM_PATH)
    const mod   = await WebAssembly.compile(bytes)

    let inst: WebAssembly.Instance | null = null
    inst = await WebAssembly.instantiate(mod, makeImports(() => inst))
    instance = inst
  })

  it('exports every letter named in WASM_EXPORTS', () => {
    const missing = Object.entries(WASM_EXPORTS)
      .filter(([, key]) => !(key in instance.exports))
      .map(([human, key]) => `${human} (${key})`)

    expect(missing, `WASM is missing exports: ${missing.join(', ')}`).toEqual([])
  })

  it('memory is a WebAssembly.Memory instance', () => {
    expect(instance.exports[WASM_EXPORTS.memory]).toBeInstanceOf(WebAssembly.Memory)
  })

  it('rnnoise_get_frame_size() returns 480 (the worklet assumes this)', () => {
    const getFrameSize = instance.exports[WASM_EXPORTS.rnnoise_get_frame_size] as () => number
    expect(getFrameSize()).toBe(RNNOISE_FRAME)
  })

  it('create/destroy round-trip returns a non-null state pointer', () => {
    const create  = instance.exports[WASM_EXPORTS.rnnoise_create]  as (m: number) => number
    const destroy = instance.exports[WASM_EXPORTS.rnnoise_destroy] as (s: number) => void
    // call __wasm_call_ctors once — the worklet does this after instantiation
    ;(instance.exports[WASM_EXPORTS.__wasm_call_ctors] as () => void)()

    const state = create(0)
    expect(state).toBeGreaterThan(0)
    expect(() => destroy(state)).not.toThrow()
  })

  it('processes a frame of silence end-to-end (calls produce finite output)', () => {
    const malloc       = instance.exports[WASM_EXPORTS.malloc] as (n: number) => number
    const free         = instance.exports[WASM_EXPORTS.free]   as (p: number) => void
    const create       = instance.exports[WASM_EXPORTS.rnnoise_create]        as (m: number) => number
    const destroy      = instance.exports[WASM_EXPORTS.rnnoise_destroy]       as (s: number) => void
    const processFrame = instance.exports[WASM_EXPORTS.rnnoise_process_frame] as (s: number, o: number, i: number) => number
    const memory       = instance.exports[WASM_EXPORTS.memory] as WebAssembly.Memory

    const state   = create(0)
    const bytes   = RNNOISE_FRAME * 4
    const inPtr   = malloc(bytes)
    const outPtr  = malloc(bytes)
    expect(inPtr).toBeGreaterThan(0)
    expect(outPtr).toBeGreaterThan(0)

    // Silence: zero-filled input.
    const heap = new Float32Array(memory.buffer)
    heap.fill(0, inPtr >> 2, (inPtr >> 2) + RNNOISE_FRAME)

    // The worklet expects this not to throw; the returned VAD probability
    // should be a finite number (RNNoise returns 0..1).
    const vadProb = processFrame(state, outPtr, inPtr)
    expect(Number.isFinite(vadProb)).toBe(true)

    // Output samples are finite (not NaN) — WASM memory may have moved during
    // processing, so re-view the heap before reading.
    const heapAfter = new Float32Array(memory.buffer)
    for (let i = 0; i < RNNOISE_FRAME; i++) {
      expect(Number.isFinite(heapAfter[(outPtr >> 2) + i])).toBe(true)
    }

    free(inPtr)
    free(outPtr)
    destroy(state)
  })
})
