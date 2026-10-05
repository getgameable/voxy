# Third-party notices

Voxy's own code is MIT licensed ([LICENSE](./LICENSE)). The package ships two
third-party binaries:

| Work                                                                                         | Where                                                                                 | Licence      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ |
| [Silero VAD](https://github.com/snakers4/silero-vad) v4 model                                | `public/models/silero_vad.onnx`, published as `@gameable/voxy/models/silero_vad.onnx` | MIT          |
| [RNNoise](https://github.com/xiph/rnnoise) (Xiph.Org, Jean-Marc Valin), built to WebAssembly | `public/wasm/rnnoise.wasm`, published as `@gameable/voxy/wasm/rnnoise.wasm`           | BSD-3-Clause |

Installed beside it by npm, with their own licences:
[onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT) and
[@echogarden/rnnoise-wasm](https://github.com/echogarden-project/rnnoise-wasm) (BSD-3-Clause).
