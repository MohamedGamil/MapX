// M7-03: the landing page lays out at phone and desktop widths, in both themes, and the first screen
// shows the heading and the primary button.
import { test, expect } from '@playwright/test';
import { BASE, browserMissing, buildAndServe, type Served } from './serve.js';

const missing = browserMissing();
test.skip(!!missing, missing ?? '');

let served: Served;
test.beforeAll(async () => {
  served = await buildAndServe();
});
test.afterAll(async () => {
  await served?.close();
});

for (const [width, height] of [[360, 740], [1280, 800]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the first screen and the layout hold at ${width}px in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await page.goto(`${served.origin}${BASE}`);
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);

      // The heading and the primary button are on the first screen, without scrolling.
      const h1 = page.getByRole('heading', { level: 1 });
      await expect(h1).toBeVisible();
      const button = page.getByRole('link', { name: 'Get started' }).first();
      await expect(button).toBeVisible();
      for (const box of [(await h1.boundingBox())!, (await button.boundingBox())!]) {
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }

      // No horizontal scroll on the page, and nothing wider than the screen.
      const overflow = (await page.evaluate('document.documentElement.scrollWidth - window.innerWidth')) as number;
      expect(overflow).toBeLessThanOrEqual(0);

      // The sections below the hero are there, and the code blocks scroll inside themselves.
      for (const name of ['What you get', 'Install and try it', 'languages', 'Works with your agent']) {
        await expect(page.getByRole('heading', { level: 2, name: new RegExp(name) })).toBeVisible();
      }
    });
  }
}

test('the primary button opens the getting-started guide under the base path', async ({ page }) => {
  await page.goto(`${served.origin}${BASE}`);
  await page.getByRole('link', { name: 'Get started' }).first().click();
  await expect(page).toHaveURL(`${served.origin}${BASE}docs/getting-started`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test.describe('copy buttons', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('copy what the block shows and say so', async ({ page }) => {
    await page.goto(`${served.origin}${BASE}`);
    const buttons = page.getByRole('button', { name: /^Copy:/ });
    expect(await buttons.count()).toBe(4);
    for (let i = 0; i < 4; i++) {
      const block = page.locator('figure.codeblock').nth(i);
      const shown = (await block.locator('pre').innerText()).trim();
      await buttons.nth(i).click();
      await expect(buttons.nth(i)).toHaveText('Copied');
      await expect(block.getByRole('status')).toHaveText('Copied to the clipboard');
      expect(((await page.evaluate('navigator.clipboard.readText()')) as string).trim()).toBe(shown);
    }
  });

  test('every code block is a named, focusable region', async ({ page }) => {
    await page.goto(`${served.origin}${BASE}`);
    const blocks = page.locator('pre.landing-code');
    expect(await blocks.count()).toBe(4);
    for (let i = 0; i < 4; i++) {
      const block = blocks.nth(i);
      await expect(block).toHaveAttribute('role', 'region');
      expect(((await block.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(3);
      await expect(block).toHaveAttribute('tabindex', '0');
    }
  });
});

test('the page works without a clipboard', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
  });
  await page.goto(`${served.origin}${BASE}`);
  await page.getByRole('button', { name: /^Copy:/ }).first().click();
  // The click is swallowed: the label stays and the page keeps working.
  await expect(page.getByRole('button', { name: /^Copy:/ }).first()).toHaveText('Copy');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await context.close();
});
