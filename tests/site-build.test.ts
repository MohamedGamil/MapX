// M7-01: the GitHub Pages site builds with one command, honours SITE_BASE, and stays out of the npm package.
//
// The site is its own package (site/package.json), so a root `npm ci` does not install it. Without
// site/node_modules the build tests skip, which keeps `npm run check` independent of the site. CI's Site
// job installs it and sets REQUIRE_SITE=1, which turns a missing install into a failure.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { buildSite } from './helpers/site-build';
import { normaliseBase } from '../site/.vitepress/base';
import { GUIDES } from '../scripts/site/sync-docs';

const ROOT = resolve(__dirname, '..');
const SITE = join(ROOT, 'site');
const installed = existsSync(join(SITE, 'node_modules', 'vitepress'));
const required = process.env.REQUIRE_SITE === '1';
const run = installed || required ? describe : describe.skip;

/** Every `href=` and `src=` value of a built page that starts with a single slash (a site-root path). */
function rootRelativeUrls(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/\b(?:href|src)="(\/[^"/][^"]*|\/)"/g)) urls.push(m[1]!);
  return urls;
}

/** Every file under a folder, as forward-slash paths relative to it. */
function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

run('site build (M7-01)', () => {
  let tmp = '';
  let outDefault = '';
  let outCustom = '';

  beforeAll(() => {
    expect(installed, 'site/node_modules is missing: run `npm ci --prefix site`').toBe(true);
    tmp = mkdtempSync(join(tmpdir(), 'mapx-site-'));
    outDefault = join(tmp, 'default');
    outCustom = join(tmp, 'custom');
    buildSite(outDefault);
    buildSite(outCustom, '/x/');
  }, 240_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the home page, the docs index and the 404 page', () => {
    for (const f of ['index.html', 'docs/index.html', '404.html']) {
      expect(existsSync(join(outDefault, f)), f).toBe(true);
    }
  });

  it('puts every site-root URL under the default base /mapx/', () => {
    for (const page of ['index.html', 'docs/index.html', 'docs/getting-started.html']) {
      const urls = rootRelativeUrls(readFileSync(join(outDefault, page), 'utf8'));
      expect(urls.length, page).toBeGreaterThan(0);
      expect(urls.filter((u) => !u.startsWith('/mapx/')), page).toEqual([]);
    }
  });

  it('puts every site-root URL under SITE_BASE=/x/', () => {
    for (const page of ['index.html', 'docs/index.html', 'docs/getting-started.html']) {
      const urls = rootRelativeUrls(readFileSync(join(outCustom, page), 'utf8'));
      expect(urls.length, page).toBeGreaterThan(0);
      expect(urls.filter((u) => !u.startsWith('/x/')), page).toEqual([]);
    }
  });

  it('makes no web-font request: no font preload, no @font-face rule and no font file in the output', () => {
    const html = readFileSync(join(outDefault, 'index.html'), 'utf8');
    expect(html).not.toMatch(/rel="preload"[^>]*\.woff2|\.woff2[^>]*rel="preload"/);
    const all = walk(outDefault);
    expect(all.filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f))).toEqual([]);
    for (const css of all.filter((f) => f.endsWith('.css'))) {
      const text = readFileSync(join(outDefault, css), 'utf8');
      expect(text, css).not.toContain('@font-face');
      expect(text, css).not.toMatch(/\.woff2?\b/);
    }
  });

  // 404.html is an empty shell that VitePress fills in the browser, so its footer is checked by M7-06's browser spec.
  it('credits the creator in the footer of the built pages and links gamil.io', () => {
    for (const f of ['index.html', 'docs/index.html']) {
      const html = readFileSync(join(outDefault, f), 'utf8');
      const footer = /<footer[^>]*class="VPFooter[^"]*"[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? '';
      expect(footer, f).toContain('Mohamed Gamil');
      expect(footer, f).toMatch(/<a [^>]*href="https:\/\/gamil\.io\/?"[^>]*rel="noopener"[^>]*>|<a [^>]*rel="noopener"[^>]*href="https:\/\/gamil\.io\/?"[^>]*>/);
    }
  });

  it('has no About page and no About entry in the navigation', () => {
    expect(existsSync(join(outDefault, 'about.html'))).toBe(false);
    expect(existsSync(join(outDefault, 'about', 'index.html'))).toBe(false);
    const html = readFileSync(join(outDefault, 'index.html'), 'utf8');
    expect(html).not.toMatch(/href="[^"]*\/about"/);
  });

  it('publishes exactly the allowlisted guides under docs/ and no Markdown from anywhere else', () => {
    const pages = walk(join(outDefault, 'docs')).filter((f) => f.endsWith('.html')).sort();
    expect(pages).toEqual(['index.html', ...GUIDES.map((g) => `${g}.html`)].sort());
    // Every guide in docs/ is either published or the test says so: a new guide must be added to GUIDES.
    const guides = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    expect([...GUIDES].sort()).toEqual(guides.sort());
    // Nothing from the internal folders reaches the output, by any route or file type.
    const all = walk(outDefault);
    expect(all.filter((f) => /(^|\/)(baton|research|reports|specs)(\/|$)/.test(f))).toEqual([]);
    expect(all.filter((f) => /PROJECT_STATE|TASKS\.json|DECISIONS/.test(f))).toEqual([]);
  });
});

describe('normaliseBase (M7-01)', () => {
  it.each([
    [undefined, '/mapx/'],
    ['', '/mapx/'],
    ['  ', '/mapx/'],
    ['/', '/'],
    ['//', '/'],
    ['x', '/x/'],
    ['/x', '/x/'],
    ['/x/', '/x/'],
    ['/a/b', '/a/b/'],
  ])('%j gives %j', (raw, expected) => {
    expect(normaliseBase(raw)).toBe(expected);
  });

  it.each(['https://example.com/mapx', '//host/x', '/a//b', '/../x', '/./x'])('refuses %j', (raw) => {
    expect(() => normaliseBase(raw)).toThrow();
  });
});

describe('site isolation (M7-01)', () => {
  it('ships nothing under site/ in the npm package', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
    const json = JSON.parse(out.slice(out.indexOf('[')));
    const paths: string[] = json[0].files.map((f: { path: string }) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p === 'site' || p.startsWith('site/'))).toEqual([]);
  }, 120_000);

  it('keeps generated and installed site folders out of git', () => {
    for (const p of ['site/node_modules/x', 'site/docs/getting-started.md', 'site/.vitepress/cache/x', 'site/.vitepress/dist/index.html']) {
      const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT });
      expect(r.status, p).toBe(0);
    }
  });

  it('has its own lockfile and pins vitepress exactly', () => {
    const pkg = JSON.parse(readFileSync(join(SITE, 'package.json'), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies.vitepress).toMatch(/^\d+\.\d+\.\d+$/);
    expect(statSync(join(SITE, 'package-lock.json')).isFile()).toBe(true);
  });
});
