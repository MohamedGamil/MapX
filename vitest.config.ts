import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // vitest uses ts source directly, but createRequire('./store-node.js')
      // needs to resolve to the .ts file during testing
    },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'wasm', 'src/ui/**'],
    testTimeout: 30000,
    // A private temp folder per run, and a teardown that fails when a test leaves an entry in it (M4-09-R5).
    globalSetup: ['./tests/global-teardown.ts'],
    // Pool: forks ensures each test suite runs in its own process,
    // avoiding SQLite native module conflicts
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/core/**', 'src/agents/**', 'src/mcp.ts', 'src/cli.ts'],
      exclude: [
        'src/ui/**',
        'src/**/*.d.ts',
        'node_modules/**',
        'dist/**',
      ],
    },
  },
});
