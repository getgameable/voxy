/**
 * Encodes an array of raw PCM Float32 ArrayBuffers into a 16-bit PCM WAV Blob.
 *
 * Each ArrayBuffer is expected to contain 32-bit float samples (4 bytes each)
 * as emitted by the AudioWorklet. The output is standard PCM WAV (format 1,
 * 16-bit, mono) which every browser <audio> element can play natively.
 */
export function encodeWav(chunks: ArrayBuffer[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((n, c) => n + c.byteLength / 4, 0)

  const WAV_HEADER_BYTES = 44
  const dataBytes = totalSamples * 2 // Int16 = 2 bytes/sample
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const v = new DataView(buf)

  // RIFF chunk
  writeStr(v, 0, 'RIFF')
  v.setUint32(4,  36 + dataBytes, true)
  writeStr(v, 8, 'WAVE')

  // fmt sub-chunk
  writeStr(v, 12, 'fmt ')
  v.setUint32(16, 16,          true) // sub-chunk size
  v.setUint16(20, 1,           true) // PCM
  v.setUint16(22, 1,           true) // mono
  v.setUint32(24, sampleRate,  true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2,           true) // block align
  v.setUint16(34, 16,          true) // bits per sample

  // data sub-chunk
  writeStr(v, 36, 'data')
  v.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (const chunk of chunks) {
    const samples = new Float32Array(chunk)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([buf], { type: 'audio/wav' })
}

function writeStr(v: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i))
}
