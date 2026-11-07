// M7-06: draws the 1200 x 630 social-sharing card, site/public/og-card.png, in headless Chromium.
// The output is committed, so a site build never needs Chromium; run this after a change to the brand or
// the tagline:  npm run site:og
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'site', 'public', 'og-card.png');

export const CARD = { width: 1200, height: 630 } as const;

export function cardHtml(logoDataUri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${CARD.width}px; height: ${CARD.height}px; background: #14161a; color: #f3f4f6;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    display: flex; align-items: center; padding: 0 88px; gap: 72px; border-top: 10px solid #ff02fe; }
  img { width: 300px; height: 300px; flex: none; }
  h1 { margin: 0; font-size: 132px; line-height: 1; letter-spacing: -3px; color: #ff02fe; }
  p.tag { margin: 22px 0 0; font-size: 50px; line-height: 1.15; font-weight: 700; }
  p.sub { margin: 26px 0 0; font-size: 28px; line-height: 1.4; color: #b7bdc8; }
  </style></head><body>
  <img src="${logoDataUri}" alt="">
  <div><h1>MapX</h1><p class="tag">Local code graph memory for LLMs</p>
  <p class="sub">Scan once. Query symbols, dependencies, impact and architecture rules without re&#8209;reading files.</p></div>
  </body></html>`;
}

export async function drawCard(): Promise<Buffer> {
  const logo = `data:image/png;base64,${readFileSync(join(ROOT, 'docs', 'images', 'mapx-logo.png')).toString('base64')}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { ...CARD }, deviceScaleFactor: 1 });
    await page.setContent(cardHtml(logo));
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const png = await drawCard();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.log(`site/public/og-card.png: ${CARD.width}x${CARD.height}, ${(png.length / 1024).toFixed(1)} KiB`);
}
