# Silero VAD Model

Place `silero_vad.onnx` here (not committed to the repo due to size).

## Download

From the silero-vad GitHub releases:
https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx

Or with curl:
```bash
curl -L https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx \
     -o public/models/silero_vad.onnx
```

## Model contract (v4)

| Tensor | Shape | Type |
|--------|-------|------|
| `input` | [1, 512] | float32 |
| `sr` | [1] | int64 (= 16000) |
| `h` | [2, 1, 64] | float32 (LSTM hidden state) |
| `c` | [2, 1, 64] | float32 (LSTM cell state) |
| `output` | [1, 1] | float32 (speech probability 0–1) |
| `hn` | [2, 1, 64] | float32 (updated hidden state) |
| `cn` | [2, 1, 64] | float32 (updated cell state) |
