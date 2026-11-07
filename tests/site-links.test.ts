// M7-06: no dead link, no missing asset, no missing #fragment and no orphan page anywhere on the built
// site. The crawler is unit-tested on a fixture first, so it is known to find each kind of defect.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSite } from './helpers/site-build';
import { crawlSite, urlOf } from './helpers/site-crawl';

const ROOT = resolve(__dirname, '..');
const installed = existsSync(join(ROOT, 'site', 'node_modules', 'vitepress'));
const run = installed || process.env.REQUIRE_SITE === '1' ? describe : describe.skip;

function fixture(files: Record<string, string>): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mapx-crawl-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('crawlSite (M7-06)', () => {
  it('maps built files to the URLs they are served at', () => {
    expect(urlOf('/b/', 'index.html')).toBe('/b/');
    expect(urlOf('/b/', 'docs/index.html')).toBe('/b/docs/');
    expect(urlOf('/b/', 'docs/x.html')).toBe('/b/docs/x');
  });

  it('finds a missing page, a missing fragment, a missing image, a missing script and an orphan page', () => {
    const f = fixture({
      'index.html': '<a href="/b/a">a</a><link href="/b/style.css" rel="stylesheet"><script src="/b/app.js"></script>',
      'style.css': 'body{}',
      'a.html': '<h1 id="top">A</h1><a href="/b/nowhere">x</a><a href="/b/#nope">y</a><a href="#top">ok</a><img src="/b/gone.png">',
      'orphan.html': '<p>nobody links here</p>',
      '404.html': '<p>not found</p>',
    });
    try {
      const r = crawlSite(f.dir, '/b/');
      expect(r.broken.sort()).toEqual(
        [
          'a.html: <a> /b/nowhere reaches no file',
          'a.html: <a> /b/#nope names no id "nope" on index.html',
          'a.html: <img> /b/gone.png reaches no file',
          'index.html: <script> /b/app.js reaches no file',
        ].sort(),
      );
      expect(r.orphans).toEqual(['orphan.html']);
      expect(r.reached).toEqual(['a.html', 'index.html']);
      expect(r.checked).toBe(7);
    } finally {
      f.done();
    }
  });

  it('resolves relative links against the page, as a browser does', () => {
    const f = fixture({
      'index.html': '<a href="docs/">docs</a>',
      'docs/index.html': '<a href="./guide">g</a><a href="../">home</a>',
      'docs/guide.html': '<a href="../docs/">back</a>',
    });
    try {
      const r = crawlSite(f.dir, '/b/');
      expect(r.broken).toEqual([]);
      expect(r.orphans).toEqual([]);
    } finally {
      f.done();
    }
  });

  it('reads single-quoted and unquoted attributes, ignores data-href, and does not throw on a malformed fragment', () => {
    const f = fixture({
      'index.html': "<a href='/b/a'>a</a><a href=/b/missing>b</a><a data-href=\"/b/ignored\" href=\"/b/a#100%\">c</a><img src='/b/none.png'>",
      'a.html': '<p>a</p>',
    });
    try {
      const r = crawlSite(f.dir, '/b/');
      expect(r.broken.sort()).toEqual(
        ['index.html: <a> /b/a#100% names no id "100%" on a.html', 'index.html: <a> /b/missing reaches no file', 'index.html: <img> /b/none.png reaches no file'].sort(),
      );
      expect(r.checked).toBe(4);
    } finally {
      f.done();
    }
  });

  it('decodes a percent-encoded path before it looks for the file', () => {
    const f = fixture({ 'index.html': '<a href="/b/two%20words">x</a>', 'two words.html': '<p>ok</p>' });
    try {
      expect(crawlSite(f.dir, '/b/').broken).toEqual([]);
    } finally {
      f.done();
    }
  });

  it('reports nothing for a site without defects, and ignores external links', () => {
    const f = fixture({ 'index.html': '<a href="https://example.org/x">e</a><a href="mailto:a@b.c">m</a>' });
    try {
      expect(crawlSite(f.dir, '/b/')).toEqual({ reached: ['index.html'], orphans: [], broken: [], checked: 0 });
    } finally {
      f.done();
    }
  });
});

run('the built site (M7-06)', () => {
  let tmp = '';
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-site-'));
    buildSite(join(tmp, 'out'));
  }, 240_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('has no dead link, missing asset or missing fragment, and no page that nothing links to', () => {
    const r = crawlSite(join(tmp, 'out'), '/mapx/');
    expect(r.broken).toEqual([]);
    expect(r.orphans).toEqual([]);
    // The home page and 13 docs pages hold hundreds of references: a regex that stopped matching must fail.
    expect(r.checked).toBeGreaterThan(400);
    expect(r.reached).toContain('docs/getting-started.html');
    expect(r.reached.length).toBe(13);
  });
});
