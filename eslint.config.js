import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['{src,test}/**/*.{ts,tsx}'],
    plugins: {
      reactHooks,
      reactRefresh,
      tseslint,
    },
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Tests & mocks — relax rules that conflict with common test patterns
  // (async stubs, deliberate unsafe casts for mock wiring, non-Error throws).
  {
    files: ['**/__tests__/**/*.ts', '**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment':       'off',
      '@typescript-eslint/no-unsafe-member-access':    'off',
      '@typescript-eslint/no-unsafe-call':             'off',
      '@typescript-eslint/no-unsafe-argument':         'off',
      '@typescript-eslint/no-unsafe-return':           'off',
      '@typescript-eslint/require-await':              'off',
      '@typescript-eslint/only-throw-error':           'off',
      '@typescript-eslint/no-empty-function':          'off',
      '@typescript-eslint/prefer-for-of':              'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type':                 'off',
      '@typescript-eslint/prefer-optional-chain':      'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
])
