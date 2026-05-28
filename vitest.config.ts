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
    // Pool: forks ensures each test suite runs in its own process,
    // avoiding SQLite native module conflicts
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/core/**', 'src/mcp.ts', 'src/cli.ts'],
      exclude: [
        'src/ui/**',
        'src/**/*.d.ts',
        'node_modules/**',
        'dist/**',
      ],
    },
  },
});
