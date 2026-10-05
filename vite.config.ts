import path from 'path'
import { cpSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

/**
 * The library ships the Silero VAD model and the RNNoise binary as
 * `@gameable/voxy/models/*` and `@gameable/voxy/wasm/*`. Only those two
 * directories of `public/` go into the package; the dev UI's test audio stays
 * behind.
 */
function copyRuntimeFiles(): Plugin {
  return {
    name: 'voxy:runtime-files',
    apply: 'build',
    closeBundle() {
      for (const dir of ['models', 'wasm']) {
        cpSync(path.resolve(__dirname, 'public', dir), path.resolve(__dirname, 'dist', dir), {
          recursive: true,
        })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), copyRuntimeFiles()],
  resolve: {
    alias: {
      '@lib': '/src/lib',
      '@types': '/src/lib/types',
      '@ui': '/src/ui',
      '@dev': '/src/dev-ui',
    },
  },
  // Prevent Vite from pre-bundling onnxruntime-web — it ships WASM that the
  // bundler cannot process correctly in a worker context. The package is
  // imported directly inside the Web Worker, which Vite bundles separately.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    // public/ is the dev server's; the build copies what the package needs.
    copyPublicDir: false,
    lib: {
      // `@gameable/voxy` is the core and the widgets; `@gameable/voxy/core` is
      // the core alone, with no DOM widgets.
      entry: {
        voxy: path.resolve(__dirname, 'src/index.ts'),
        core: path.resolve(__dirname, 'src/lib/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.es.js`,
    },
    rollupOptions: {
      // onnxruntime-web is loaded at runtime via configurable URL — do not bundle it
      external: ['onnxruntime-web'],
    },
  },
})
