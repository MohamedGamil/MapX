// Browser tests for the GitHub Pages site (M7-02): `npx playwright test -c playwright.site.config.ts`.
// Separate from playwright.config.ts so `npm run test:ui` (the dashboard) is unchanged. Each spec builds
// the site into a private temp folder, serves it under the base path and drives headless Chromium;
// without an installed Chromium the specs skip and say so.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/site',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  globalSetup: './tests/site/global-setup.ts',
  globalTeardown: './tests/site/global-teardown.ts',
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: 'test-results/site',
  use: { browserName: 'chromium', headless: true, viewport: { width: 1280, height: 800 } },
});
