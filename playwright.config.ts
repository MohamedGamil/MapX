// Browser tests for the dashboard (docs/baton M4-19, D027): `npm run test:ui`.
// Each spec scans a generated fixture workspace, serves it with `mapx ui` from source and drives it
// in headless Chromium. Without an installed Chromium the specs skip and say so.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  testMatch: /.*\.spec\.ts$/,
  // One worker: the specs share scanned workspaces per file, and timings need a quiet browser.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  globalSetup: './tests/ui/global-setup.ts',
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: 'test-results/ui',
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 900 } },
});
