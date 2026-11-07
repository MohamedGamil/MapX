// M7-02: the documentation section of the site. The rewriter and the sync are unit-tested without the
// site's dependencies; the built output is checked when site/node_modules exists (REQUIRE_SITE=1 makes
// a missing install a failure, as in tests/site-build.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildSite } from './helpers/site-build';
import { GUIDE_META, GUIDES, REPO_BLOB, rewriteLinks, syncDocs } from '../scripts/site/sync-docs';

const ROOT = resolve(__dirname, '..');
const SITE = join(ROOT, 'site');
const installed = existsSync(join(SITE, 'node_modules', 'vitepress'));
const run = installed || process.env.REQUIRE_SITE === '1' ? describe : describe.skip;

/** A scratch repo root with the files a link may point at, removed after the test. */
function scratch(files: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mapx-site-docs-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe('rewriteLinks (M7-02)', () => {
  let s: ReturnType<typeof scratch>;
  beforeAll(() => {
    s = scratch({ 'README.md': '# R\n', '.mapx/architecture.jsonc': '{}\n', 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' });
  });
  afterAll(() => s.done());
  const names = ['a', 'b'];
  const fix = (md: string) => rewriteLinks(md, 'a', s.root, names);

  it('leaves external, anchor, mail and guide links alone', () => {
    const md = '[x](https://example.com/p) [y](#top) [z](mailto:a@b.c) [g](b.md) [h](./b.md#sec) [i](b)\n';
    expect(fix(md)).toBe(md);
  });

  it('leaves images under ./images alone', () => {
    expect(fix('![d](./images/x.png)\n')).toBe('![d](./images/x.png)\n');
  });

  it('turns a link to an existing unpublished repo file into a GitHub blob URL, keeping the fragment', () => {
    expect(fix('See the [README](../README.md#install) and [cfg](../.mapx/architecture.jsonc).\n')).toBe(
      `See the [README](${REPO_BLOB}README.md#install) and [cfg](${REPO_BLOB}.mapx/architecture.jsonc).\n`,
    );
  });

  it('rewrites reference-style definitions too', () => {
    expect(fix('[r]\n\n[r]: ../README.md\n')).toBe(`[r]\n\n[r]: ${REPO_BLOB}README.md\n`);
  });

  it('does not look inside fenced code, inline code or HTML comments', () => {
    const md = '```md\n[a](../nope.md)\n```\n\nUse `[a](../nope.md)`.\n\n<!-- [a](../nope.md) ![i](./images/none.png) -->\n';
    expect(fix(md)).toBe(md);
  });

  it('is not fooled by a fence whose opening line holds backticks', () => {
    // "```code```" is inline code, not a fence: the link after it is still a link.
    expect(fix('```code``` is how you write it\n\n[x](../README.md)\n')).toBe(`\`\`\`code\`\`\` is how you write it\n\n[x](${REPO_BLOB}README.md)\n`);
  });

  it('handles longer and tilde fences holding shorter fences, and fences in blockquotes', () => {
    const md = '````md\n```\n[a](../nope.md)\n```\n````\n\n~~~\n[a](../nope.md)\n~~~\n\n> ```\n> [a](../nope.md)\n> ```\n\n[x](../README.md)\n';
    expect(fix(md)).toBe(md.replace('[x](../README.md)', `[x](${REPO_BLOB}README.md)`));
  });

  it('does not open a comment inside inline code, and keeps the comment state across lines', () => {
    expect(fix('Use `<!--` to open.\n\n[x](../README.md)\n')).toBe(`Use \`<!--\` to open.\n\n[x](${REPO_BLOB}README.md)\n`);
    expect(fix('<!--\n[a](../nope.md)\n-->\n[b](../README.md)\n')).toBe(`<!--\n[a](../nope.md)\n-->\n[b](${REPO_BLOB}README.md)\n`);
  });

  it('rewrites the link of a linked image and leaves the image alone', () => {
    expect(fix('[![d](./images/x.png)](../README.md)\n')).toBe(`[![d](./images/x.png)](${REPO_BLOB}README.md)\n`);
  });

  it('finds links with quoted titles, nested brackets, angle brackets and queries', () => {
    const url = `${REPO_BLOB}README.md`;
    expect(fix("[x](../README.md 'T') [y](../README.md (T)) [z](../README.md \"T\")\n")).toBe(`[x](${url} 'T') [y](${url} (T)) [z](${url} "T")\n`);
    expect(fix('[a [b]](../README.md)\n')).toBe(`[a [b]](${url})\n`);
    expect(fix('[a](<../README.md>)\n')).toBe(`[a](${url})\n`);
    expect(fix('[a](../README.md?plain=1#x)\n')).toBe(`[a](${url}?plain=1#x)\n`);
  });

  it('rewrites reference definitions in lists and blockquotes, and leaves footnotes alone', () => {
    const url = `${REPO_BLOB}README.md`;
    expect(fix('- [r]: ../README.md\n> [q]: ../README.md\n')).toBe(`- [r]: ${url}\n> [q]: ${url}\n`);
    expect(fix('[^1]: See the docs.\n')).toBe('[^1]: See the docs.\n');
  });

  it('reports a name that merely starts with two dots as missing, not as leaving the repository', () => {
    expect(() => fix('[x](../..foo)\n')).toThrow(/does not exist/);
  });

  it('fails on a link to a file that does not exist, naming the guide and the line', () => {
    expect(() => fix('one\ntwo\n[gone](../nope.md)\n')).toThrow(/docs\/a\.md:3.*\.\.\/nope\.md/);
  });

  it('fails on a link to a guide that is not published', () => {
    expect(() => fix('[x](c.md)\n')).toThrow(/docs\/a\.md:1/);
  });

  it('fails on a link that leaves the repository', () => {
    expect(() => fix('[x](../../etc/passwd)\n')).toThrow(/docs\/a\.md:1/);
  });
});

describe('rewriteLinks and git (M7-02)', () => {
  it('refuses a link to a file git does not track, because GitHub has no page for it', () => {
    const s = scratch({ 'README.md': '# R\n', '.env': 'SECRET=1\n', '.gitignore': '.env\n', 'docs/a.md': '# A\n' });
    try {
      execFileSync('git', ['init', '-q'], { cwd: s.root });
      execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: s.root });
      expect(rewriteLinks('[r](../README.md)\n', 'a', s.root, ['a'])).toBe(`[r](${REPO_BLOB}README.md)\n`);
      expect(() => rewriteLinks('[e](../.env)\n', 'a', s.root, ['a'])).toThrow(/docs\/a\.md:1.*not tracked by git/);
    } finally {
      s.done();
    }
  });
});

describe('syncDocs (M7-02)', () => {
  it('stops with the file and line of a bad link before any build', () => {
    const s = scratch({ 'docs/only.md': '# Only\n\n[x](../missing.md)\n' });
    try {
      expect(() => syncDocs(s.root, [{ name: 'only', label: 'Only', group: 'G' }])).toThrow(/docs\/only\.md:3/);
    } finally {
      s.done();
    }
  });

  it('lists every guide once, in a group, with a label', () => {
    expect(new Set(GUIDES).size).toBe(GUIDES.length);
    expect(GUIDE_META.map((g) => g.name)).toEqual([...GUIDES]);
    for (const g of GUIDE_META) {
      expect(g.label.length, g.name).toBeGreaterThan(0);
      expect(g.group.length, g.name).toBeGreaterThan(0);
    }
  });
});

/** Maps a built URL under the base to the file VitePress wrote for it. */
function fileFor(out: string, base: string, path: string): string | null {
  if (!path.startsWith(base)) return null;
  const rel = path.slice(base.length);
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [`${rel}.html`, rel, `${rel}/index.html`];
  // Only a file counts: GitHub Pages answers a folder without an index with a 404.
  for (const c of candidates) if (existsSync(join(out, c)) && statSync(join(out, c)).isFile()) return join(out, c);
  return null;
}

run('built documentation (M7-02)', () => {
  let tmp = '';
  let out = '';
  const base = '/mapx/';
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  const page = (name: string) => readFileSync(join(out, 'docs', `${name}.html`), 'utf8');

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-site-'));
    out = join(tmp, 'out');
    buildSite(out);
  }, 240_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('has a sidebar entry on every guide page for every guide', () => {
    for (const g of GUIDES) {
      const html = page(g);
      for (const other of GUIDE_META) {
        expect(html, `${g} -> ${other.name}`).toContain(`href="${base}docs/${other.name}"`);
      }
    }
  });

  it('resolves every internal link, image and #fragment of the docs pages', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const p of ['index', ...GUIDES]) {
      const html = page(p);
      const here = `http://site.test${base}docs/${p === 'index' ? '' : p}`;
      const refs = [
        ...[...html.matchAll(/<a [^>]*?\bhref="([^"]+)"/g)].map((m) => ({ tag: 'a', value: m[1]! })),
        ...[...html.matchAll(/<img [^>]*?\bsrc="([^"]+)"/g)].map((m) => ({ tag: 'img', value: m[1]! })),
      ];
      for (const { tag, value } of refs) {
        const href = value.replace(/&amp;/g, '&');
        if (/^(https?:|mailto:|data:|\/\/)/.test(href)) continue;
        checked++;
        // Resolved as a browser does: against the URL the page is served at (cleanUrls, no .html).
        const url = new URL(href, here);
        const frag = url.hash.slice(1);
        const target = fileFor(out, base, url.pathname);
        if (!target) {
          broken.push(`${p}: <${tag}> ${href} has no file`);
          continue;
        }
        const id = decodeURIComponent(frag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (frag && !new RegExp(`\\sid="${id}"`).test(readFileSync(target, 'utf8'))) {
          broken.push(`${p}: ${href} has no id "${frag}" on ${relative(out, target)}`);
        }
      }
    }
    expect(broken).toEqual([]);
    // The guides hold hundreds of cross-links: a regex that stopped matching must not pass silently.
    expect(checked).toBeGreaterThan(200);
  });

  it('points links to unpublished repo files at GitHub', () => {
    expect(page('getting-started')).toContain(`href="${REPO_BLOB}README.md#pre-built-binary"`);
    expect(page('architecture-rules')).toContain(`href="${REPO_BLOB}.mapx/architecture.jsonc"`);
  });

  it('shows the version on every docs page and an edit link naming the source file', () => {
    // In the navigation bar, as a link to the changelog; not just any mention on the page.
    for (const p of ['index', ...GUIDES]) {
      expect(page(p), p).toMatch(new RegExp(`<a [^>]*href="[^"]*CHANGELOG\\.md"[^>]*>(?:<!--\\[-->)?<span[^>]*>v${version.replace(/\./g, '\\.')}<`));
    }
    for (const g of GUIDES) {
      expect(page(g), g).toContain(`href="https://github.com/MohamedGamil/mapx/edit/main/docs/${g}.md"`);
    }
    expect(page('index')).not.toContain('edit-link-button');
    expect(page('getting-started')).toContain('edit-link-button');
  });

  it('fails the build on a dead link (ignoreDeadLinks is off) and builds when the link is fixed', () => {
    // A throwaway project that mirrors the repo layout, so the site's own configuration is what runs.
    const proj = join(tmp, 'deadlink');
    mkdirSync(join(proj, 'site'), { recursive: true });
    cpSync(join(SITE, '.vitepress'), join(proj, 'site', '.vitepress'), {
      recursive: true,
      filter: (src) => !/[\\/]\.vitepress[\\/](cache|dist)([\\/]|$)/.test(src),
    });
    cpSync(join(SITE, 'package.json'), join(proj, 'site', 'package.json'));
    mkdirSync(join(proj, 'scripts', 'site'), { recursive: true });
    cpSync(join(ROOT, 'scripts', 'site', 'sync-docs.ts'), join(proj, 'scripts', 'site', 'sync-docs.ts'));
    cpSync(join(ROOT, 'VERSION'), join(proj, 'VERSION'));
    symlinkSync(join(SITE, 'node_modules'), join(proj, 'site', 'node_modules'), 'dir');
    mkdirSync(join(proj, 'site', 'docs'), { recursive: true });
    writeFileSync(join(proj, 'site', 'index.md'), '# Home\n');
    const build = () =>
      spawnSync(process.execPath, [join(SITE, 'node_modules', 'vitepress', 'bin', 'vitepress.js'), 'build', join(proj, 'site')], {
        env: { ...process.env, SITE_OUT: join(proj, 'out') },
        encoding: 'utf8',
      });

    writeFileSync(join(proj, 'site', 'docs', 'index.md'), '# Docs\n\n[ok](../)\n');
    const good = build();
    expect(good.status, `${good.stdout}${good.stderr}`).toBe(0);

    writeFileSync(join(proj, 'site', 'docs', 'index.md'), '# Docs\n\n[gone](./does-not-exist)\n');
    const bad = build();
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/dead link/i);
  }, 240_000);

  it('indexes every guide for search and finds architecture-rules for "layers"', () => {
    const dir = join(out, 'assets', 'chunks');
    const file = readdirSync(dir).find((f) => /^@localSearchIndexroot\./.test(f));
    expect(file, 'local search index').toBeDefined();
    // The chunk is `const e='<json>';export{e as default};`: evaluate it for the JSON text.
    const source = readFileSync(join(dir, file!), 'utf8').replace(/export\s*\{[^}]*\};?\s*$/, '');
    const json = new Function(`${source};return e;`)() as string;
    const documentIds = Object.values(JSON.parse(json).documentIds) as string[];
    for (const g of GUIDES) {
      expect(documentIds.some((id) => id.startsWith(`${base}docs/${g}#`)), g).toBe(true);
    }
    const MiniSearch = createRequire(join(SITE, 'package.json'))('minisearch');
    const ms = MiniSearch.loadJSON(json, { fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'] });
    // The options of the site's search box (VPLocalSearchBox), which shows the first 16 results.
    const hits: string[] = ms
      .search('layers', { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } })
      .slice(0, 16)
      .map((r: { id: string }) => r.id);
    expect(hits.some((id) => id.startsWith(`${base}docs/architecture-rules`))).toBe(true);
  });
});
