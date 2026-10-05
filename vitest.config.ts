import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@lib':    path.resolve(__dirname, 'src/lib'),
      '@types':  path.resolve(__dirname, 'src/lib/types'),
      '@ui':     path.resolve(__dirname, 'src/ui'),
      '@dev':    path.resolve(__dirname, 'src/dev-ui'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/vitest-setup.ts',
    include: ['src/**/__tests__/**/*.spec.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/index.{ts,tsx}'],
    },
  },
})
