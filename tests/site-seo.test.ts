// M7-06: what search engines and link previews see: a sitemap, canonical URLs, robots.txt, complete
// head tags with a real 1200 x 630 card, and the size budgets. Built twice: with the defaults, and with
// another origin and base, to show that nothing is hard-coded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildSite } from './helpers/site-build';
import { GUIDES } from '../scripts/site/sync-docs';
import { folderBytes, urlOf } from './helpers/site-crawl';

const ROOT = resolve(__dirname, '..');
const installed = existsSync(join(ROOT, 'site', 'node_modules', 'vitepress'));
const run = installed || process.env.REQUIRE_SITE === '1' ? describe : describe.skip;
const budgets = JSON.parse(readFileSync(join(ROOT, 'tests', 'site', 'budgets.json'), 'utf8')) as {
  totalBytes: number;
  homeGzipBytes: number;
};

function htmlFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name), root) : e.name.endsWith('.html') ? [relative(root, join(dir, e.name)).split('\\').join('/')] : [],
  );
}

/** The width and height in a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('ascii'), 'PNG signature').toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const meta = (html: string, attr: 'name' | 'property', key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, 'g'))].map((m) => m[1]!);

function checkSite(out: string, origin: string, base: string): void {
  const site = `${origin}${base}`;
  const pages = htmlFiles(out).filter((f) => f !== '404.html');
  const expected = pages.map((f) => `${origin}${urlOf(base, f)}`).sort();

  // The built pages are the ones expected: the home page, the docs index and every guide.
  expect([...pages].sort()).toEqual(['docs/index.html', ...GUIDES.map((g) => `docs/${g}.html`), 'index.html'].sort());

  // The sitemap lists exactly the built pages, with absolute URLs.
  const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!).sort();
  expect(listed).toEqual(expected);
  expect(listed.some((u) => u.includes('404'))).toBe(false);

  // robots.txt names the sitemap by the same absolute URL.
  expect(readFileSync(join(out, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${site}sitemap.xml`);

  const descriptions: string[] = [];
  for (const f of pages) {
    const html = readFileSync(join(out, f), 'utf8');
    const url = `${origin}${urlOf(base, f)}`;
    // One canonical link, equal to the sitemap entry and to og:url.
    expect([...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]), `${f} canonical`).toEqual([url]);
    expect(meta(html, 'property', 'og:url'), `${f} og:url`).toEqual([url]);
    // A title, a description and the Open Graph set, with an absolute image.
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]?.length ?? 0, `${f} title`).toBeGreaterThan(2);
    const description = meta(html, 'name', 'description')[0] ?? '';
    expect(description.length, `${f} description`).toBeGreaterThanOrEqual(50);
    expect(description.length, `${f} description`).toBeLessThanOrEqual(160);
    expect(meta(html, 'property', 'og:description'), `${f} og:description`).toEqual([description]);
    descriptions.push(description);
    for (const p of ['og:title', 'og:description', 'og:type', 'og:image:alt']) {
      expect(meta(html, 'property', p), `${f} ${p}`).toHaveLength(1);
      expect(meta(html, 'property', p)[0]!.length, `${f} ${p}`).toBeGreaterThan(2);
    }
    expect(meta(html, 'property', 'og:image'), `${f} og:image`).toEqual([`${site}og-card.png`]);
    expect(meta(html, 'property', 'og:image:width')).toEqual(['1200']);
    expect(meta(html, 'property', 'og:image:height')).toEqual(['630']);
    expect(meta(html, 'name', 'twitter:card')).toEqual(['summary_large_image']);
  }

  // Every page says something of its own to a search engine.
  expect(new Set(descriptions).size, 'descriptions are different on every page').toBe(descriptions.length);

  // The 404 page has a title, no canonical link and no address of its own, and the card it points at exists.
  const notFound = readFileSync(join(out, '404.html'), 'utf8');
  expect(notFound).not.toContain('rel="canonical"');
  expect(meta(notFound, 'property', 'og:url')).toEqual([]);
  expect(/<title>([^<]+)<\/title>/.exec(notFound)?.[1]?.length ?? 0).toBeGreaterThan(2);
  expect(existsSync(join(out, 'og-card.png'))).toBe(true);
}

run('built site: SEO and budgets (M7-06)', () => {
  let tmp = '';
  let out = '';
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-site-'));
    out = join(tmp, 'out');
    buildSite(out);
    buildSite(join(tmp, 'custom'), '/x/', { SITE_URL: 'https://example.org' });
  }, 360_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('has a sitemap, robots.txt, canonical URLs and complete head tags, with the default origin and base', () => {
    checkSite(out, 'https://mohamedgamil.github.io', '/mapx/');
  });

  it('uses the configured origin and base everywhere (SITE_URL=https://example.org, SITE_BASE=/x/)', () => {
    checkSite(join(tmp, 'custom'), 'https://example.org', '/x/');
  });

  it('ships a 1200 x 630 card of at most 150 KiB, as the committed file and as built', () => {
    for (const file of [join(ROOT, 'site', 'public', 'og-card.png'), join(out, 'og-card.png')]) {
      expect(pngSize(file)).toEqual({ width: 1200, height: 630 });
      expect(statSync(file).size).toBeLessThanOrEqual(150 * 1024);
    }
  });

  it('stays within the size budgets (tests/site/budgets.json)', () => {
    expect(folderBytes(out)).toBeLessThanOrEqual(budgets.totalBytes);

    // The home page's transfer: its HTML plus every script, stylesheet and image it loads from the site
    // (the hero image included), each gzipped as a server would send it.
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const loaded = new Set<string>();
    for (const m of html.matchAll(/<(?:script|link)\s[^>]*?(?:src|href)="(\/mapx\/[^"]+\.(?:js|css))"/g)) loaded.add(m[1]!);
    // Images marked loading="lazy" (the screenshots, below the first screen) are not part of the first load.
    for (const m of html.matchAll(/<img\s[^>]*?>/g)) {
      const src = /\ssrc="(\/mapx\/[^"]+)"/.exec(m[0])?.[1];
      if (src && !/\sloading="lazy"/.test(m[0])) loaded.add(src);
    }
    expect(loaded.size, 'the home page loads scripts, styles and its image').toBeGreaterThan(3);
    expect([...loaded].some((u) => u.endsWith('.css') && !u.includes('/assets/')), 'vp-icons.css is counted').toBe(true);
    expect([...loaded].some((u) => u.endsWith('.png')), 'the hero image is counted').toBe(true);
    const transfer =
      gzipSync(html).length + [...loaded].reduce((n, a) => n + gzipSync(readFileSync(join(out, a.replace('/mapx/', '')))).length, 0);
    expect(transfer).toBeLessThanOrEqual(budgets.homeGzipBytes);
  });
});
