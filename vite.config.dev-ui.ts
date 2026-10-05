import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// Builds the dev UI as a standard SPA (not library mode).
// Usage: npm run build:dev-ui
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  resolve: {
    alias: {
      '@lib': '/src/lib',
      '@types': '/src/lib/types',
      '@ui': '/src/ui',
      '@dev': '/src/dev-ui',
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    outDir: 'dist-dev-ui',
  },
})
