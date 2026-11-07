// M7-02: the creator credit stays visible on guide pages, which have a sidebar (the default theme hides
// the footer there), on a wide screen and on a phone.
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

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 360, height: 740 }]] as const) {
  test(`the footer credit is visible beside the sidebar on a guide page (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(`${served.origin}${BASE}docs/getting-started`);
    const footer = page.locator('footer.VPFooter');
    await expect(footer).toBeVisible();
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toContainText('MapX is created by Mohamed Gamil');
    const link = footer.getByRole('link', { name: 'gamil.io' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://gamil.io');

    // No horizontal scroll on the page.
    const overflow = (await page.evaluate('document.documentElement.scrollWidth - window.innerWidth')) as number;
    expect(overflow).toBeLessThanOrEqual(0);

    // Nothing covers the link: the element at its centre is the link itself.
    const box = (await link.boundingBox())!;
    const topmost = await page.evaluate(
      `(() => { const e = document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2}); return e ? (e.closest('a') ? e.closest('a').getAttribute('href') : e.tagName) : null; })()`,
    );
    expect(topmost).toBe('https://gamil.io');

    if (name === 'desktop') {
      // The sidebar is shown and the credit's link lies to its right, not underneath it.
      const sidebar = page.locator('aside.VPSidebar');
      await expect(sidebar).toBeVisible();
      const s = (await sidebar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(s.x + s.width);
    }
  });
}

test('the docs sidebar lists every group and the search button is present', async ({ page }) => {
  await page.goto(`${served.origin}${BASE}docs/architecture-rules`);
  const sidebar = page.locator('aside.VPSidebar');
  for (const group of ['Start', 'Reference', 'Architecture rules', 'Guides', 'Internals']) {
    await expect(sidebar.getByText(group, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /search/i }).first()).toBeVisible();
});
