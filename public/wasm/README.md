# RNNoise WASM Binary

Place `rnnoise.wasm` in this directory for spectral noise suppression.

## Required exports

The standalone WASM binary must export:

- `rnnoise_create()` — allocate denoiser state
- `rnnoise_process_frame(state, output_ptr, input_ptr)` — denoise 480 samples, returns VAD probability
- `rnnoise_destroy(state)` — free denoiser state
- `rnnoise_get_frame_size()` — returns 480
- `malloc(bytes)` / `free(ptr)` — heap allocation
- `memory` — exported WASM linear memory

## Building from source

```bash
# Requires Emscripten SDK
git clone https://github.com/nickolay/nickolay.git  # or xiph/rnnoise
cd rnnoise
./autogen.sh && ./configure
emmake make

emcc .libs/librnnoise.a -O3 \
  -s STANDALONE_WASM \
  -s EXPORTED_FUNCTIONS='["_rnnoise_create","_rnnoise_destroy","_rnnoise_process_frame","_rnnoise_get_frame_size","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='[]' \
  -o rnnoise.wasm
```

The resulting file is ~90 KB.

## Graceful degradation

If this file is missing or fails to load, Voxy continues without spectral
noise suppression and emits a `warn` event with code `NOISE_SUPPRESSION_UNAVAILABLE`.
