// M7-07: the dashboard screenshots on the landing page come from a script. Running it twice must give
// the same pictures (a pixel difference under 1 percent, compared in the browser), each a 1280 x 800
// WebP of at most 150 KiB; and the committed images must be of that shape too.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { generateScreenshots } from '../../scripts/site/gen-screenshots.js';
import { SCREENSHOTS, SHOT_HEIGHT, SHOT_MAX_BYTES, SHOT_WIDTH } from '../../scripts/site/screenshot-list.js';
import { REPO } from '../helpers/site-build.js';
import { browserMissing } from './serve.js';

const missing = browserMissing();
test.skip(!!missing, missing ?? '');
test.setTimeout(600_000);

declare const document: any;
declare const Image: any;

/** The share of pixels of two images (data URLs) that differ by more than a few levels. */
async function differing(a: Buffer, b: Buffer): Promise<{ share: number; size: [number, number] }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const [x, y] = [a, b].map((buf) => `data:image/webp;base64,${buf.toString('base64')}`);
    return await page.evaluate(
      async ([u1, u2]) => {
        const load = async (src: string) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return { w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data };
        };
        const [p, q] = [await load(u1!), await load(u2!)];
        if (p.w !== q.w || p.h !== q.h) return { share: 1, size: [p.w, p.h] as [number, number] };
        let n = 0;
        for (let i = 0; i < p.d.length; i += 4) {
          if (Math.abs(p.d[i]! - q.d[i]!) + Math.abs(p.d[i + 1]! - q.d[i + 1]!) + Math.abs(p.d[i + 2]! - q.d[i + 2]!) > 24) n++;
        }
        return { share: n / (p.w * p.h), size: [p.w, p.h] as [number, number] };
      },
      [x!, y!],
    );
  } finally {
    await browser.close();
  }
}

/** Width and height from a WebP header (lossy `VP8 `, lossless `VP8L` or extended `VP8X`). */
function webpSize(buf: Buffer): [number, number] {
  expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(buf.subarray(8, 12).toString('ascii')).toBe('WEBP');
  const kind = buf.subarray(12, 16).toString('ascii');
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
  }
  return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
}

test('the committed screenshots are 1280 x 800 WebP files of at most 150 KiB', () => {
  const dir = join(REPO, 'site', 'public', 'img');
  expect(readdirSync(dir).filter((f) => f.endsWith('.webp')).sort()).toEqual(SCREENSHOTS.map((s) => s.file).sort());
  for (const s of SCREENSHOTS) {
    const file = join(dir, s.file);
    expect(statSync(file).size, s.file).toBeLessThanOrEqual(SHOT_MAX_BYTES);
    expect(webpSize(readFileSync(file)), s.file).toEqual([SHOT_WIDTH, SHOT_HEIGHT]);
  }
});

test('the generator gives the same pictures twice (under 1 percent of pixels differ)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mapx-shots-'));
  try {
    const one = join(tmp, 'one');
    const two = join(tmp, 'two');
    await generateScreenshots(one);
    await generateScreenshots(two);
    for (const s of SCREENSHOTS) {
      const a = readFileSync(join(one, s.file));
      const b = readFileSync(join(two, s.file));
      expect(a.length, s.file).toBeLessThanOrEqual(SHOT_MAX_BYTES);
      expect(webpSize(a), s.file).toEqual([SHOT_WIDTH, SHOT_HEIGHT]);
      const { share } = await differing(a, b);
      test.info().annotations.push({ type: 'pixel difference', description: `${s.file}: ${(share * 100).toFixed(3)} percent` });
      process.stdout.write(`[screenshots] ${s.file}: ${(share * 100).toFixed(3)} percent of the pixels differ between two runs\n`);
      // The criterion is 1 percent. Two runs differ by at most 0.04 percent (a few pixels of text
      // anti-aliasing in the graph), so the test holds them to a quarter of a percent: a visibly different
      // picture (a moved node, a changed number) is hundreds to thousands of pixels.
      expect(share, `${s.file} differs in ${(share * 100).toFixed(3)} percent of its pixels`).toBeLessThan(0.0025);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
