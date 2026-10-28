import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    globals: true,
    // Each suite that touches the platform API boots a Miniflare D1 instance and
    // applies the schema in beforeEach. That costs a few seconds cold and can
    // exceed the 10s default when the suite runs in parallel on a loaded machine,
    // which surfaced as "Hook timed out" rather than a failed assertion.
    hookTimeout: 30_000,
  },
})
