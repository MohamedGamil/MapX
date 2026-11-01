// The Configuration tab (M4-22, criterion 3): settings with their sources, built-in patterns folded
// away, the user's own shown, and the configuration's warnings. Read-only: no control edits it.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initAndScan, smokeWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

test.skip(!!browserMissing(), browserMissing() ?? '');

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('config', (root) => {
    smokeWorkspace(root);
    initAndScan(root);
    const path = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.settings.excludePatterns.push('custom/generated/**');
    config.settings.parseWorkers = 'lots';
    config.settings.colour = 'blue';
    writeFileSync(path, JSON.stringify(config, null, 2));
  });
});
test.afterAll(() => served?.stop());

test('the Configuration tab shows settings, their sources and the warnings', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(served.url);
  await graphReady(page);
  await page.click('.nav-item[data-tab="config"]');
  const warnings = page.locator('#config-warnings');
  await expect(warnings).toContainText('2 warnings');
  await expect(warnings).toContainText('settings.parseWorkers: expected "auto" or a whole number');
  await expect(warnings).toContainText('settings.colour: unknown setting');
  const excludes = page.locator('#table-config tr[data-setting="excludePatterns"]');
  await expect(excludes.locator('.config-chip.is-user')).toHaveText(['custom/generated/**']);
  await expect(excludes.locator('summary')).toContainText('built-in patterns');
  await expect(excludes).toContainText('user');
  await expect(page.locator('#table-config tr[data-setting="maxTokenBudget"]')).toContainText('16384');
  await expect(page.locator('#table-config tr[data-setting="maxTokenBudget"] .selection-badge')).toHaveText('default');
  await expect(page.locator('#config-path')).toContainText('.mapx/config.json');
  // Nothing on the tab edits the configuration.
  expect(await page.locator('#tab-config :is(input, textarea, select, button)').count()).toBe(0);
  expect(errors).toEqual([]);
});
