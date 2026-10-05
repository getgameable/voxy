import { describe, it, expect } from 'vitest'
import { encodeWav } from '../wavEncode'

async function readBlob(b: Blob): Promise<DataView> {
  const buf = await b.arrayBuffer()
  return new DataView(buf)
}

function readStr(v: DataView, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(v.getUint8(offset + i))
  return s
}

function f32Buffer(samples: number[]): ArrayBuffer {
  return new Float32Array(samples).buffer
}

describe('encodeWav', () => {
  it('writes a correct RIFF/WAVE/fmt/data header for a single chunk', async () => {
    const blob = encodeWav([f32Buffer([0, 0])], 16000)
    const v    = await readBlob(blob)

    expect(blob.type).toBe('audio/wav')
    expect(readStr(v, 0, 4)).toBe('RIFF')
    expect(readStr(v, 8, 4)).toBe('WAVE')
    expect(readStr(v, 12, 4)).toBe('fmt ')
    expect(readStr(v, 36, 4)).toBe('data')

    // fmt chunk contents
    expect(v.getUint32(16, true)).toBe(16)          // fmt chunk size
    expect(v.getUint16(20, true)).toBe(1)           // PCM
    expect(v.getUint16(22, true)).toBe(1)           // mono
    expect(v.getUint32(24, true)).toBe(16000)       // sample rate
    expect(v.getUint32(28, true)).toBe(16000 * 2)   // byte rate
    expect(v.getUint16(32, true)).toBe(2)           // block align
    expect(v.getUint16(34, true)).toBe(16)          // bits/sample

    // data chunk size = samples * 2 bytes
    expect(v.getUint32(40, true)).toBe(2 * 2)
    // riff size = 36 + dataBytes
    expect(v.getUint32(4, true)).toBe(36 + 4)
  })

  it('advertises the configured sample rate', async () => {
    const v = await readBlob(encodeWav([f32Buffer([0])], 48000))
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(48000 * 2)
  })

  it('produces 44-byte header + 2 bytes per float sample', async () => {
    const chunks = [f32Buffer([0.1, 0.2, 0.3, 0.4])]
    const blob = encodeWav(chunks, 16000)
    expect(blob.size).toBe(44 + 4 * 2)
  })

  it('clamps samples to [-1, 1] and maps to signed 16-bit PCM', async () => {
    const chunks = [f32Buffer([0, 1, -1, 2, -2, 0.5, -0.5])]
    const v = await readBlob(encodeWav(chunks, 16000))

    // data region starts at offset 44
    expect(v.getInt16(44 + 0 * 2, true)).toBe(0)
    expect(v.getInt16(44 + 1 * 2, true)).toBe(0x7fff)   // +1 → max positive
    expect(v.getInt16(44 + 2 * 2, true)).toBe(-0x8000)  // -1 → max negative
    expect(v.getInt16(44 + 3 * 2, true)).toBe(0x7fff)   // clamped from +2
    expect(v.getInt16(44 + 4 * 2, true)).toBe(-0x8000)  // clamped from -2

    // setInt16 truncates toward zero, so +0.5 * 0x7fff = 16383.5 → 16383
    expect(v.getInt16(44 + 5 * 2, true)).toBe(Math.trunc(0.5 * 0x7fff))
    // -0.5 * 0x8000 = -16384 exactly
    expect(v.getInt16(44 + 6 * 2, true)).toBe(Math.trunc(-0.5 * 0x8000))
  })

  it('concatenates multiple chunks in order', async () => {
    const chunks = [f32Buffer([1]), f32Buffer([-1]), f32Buffer([0])]
    const v = await readBlob(encodeWav(chunks, 16000))

    expect(v.getInt16(44 + 0, true)).toBe(0x7fff)
    expect(v.getInt16(44 + 2, true)).toBe(-0x8000)
    expect(v.getInt16(44 + 4, true)).toBe(0)
  })

  it('handles empty input — emits a 44-byte header-only WAV', async () => {
    const blob = encodeWav([], 16000)
    const v    = await readBlob(blob)

    expect(blob.size).toBe(44)
    expect(readStr(v, 0, 4)).toBe('RIFF')
    expect(v.getUint32(40, true)).toBe(0)      // data length
    expect(v.getUint32(4, true)).toBe(36 + 0)  // riff size
  })
})
