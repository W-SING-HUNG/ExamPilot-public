import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/bank.json',
      'data/local-bank.json',
      'src/lib/local-bank.generated.ts',
      'tools/**',
      'tests/**',
      'scratch/**',
      '*.config.ts',
      '*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  // Browser app code
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // Node scripts (AI proxy, build tooling) — server code, no DOM globals
  {
    files: ['server/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'eslint.config.mjs', 'vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
