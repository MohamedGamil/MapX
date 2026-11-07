// M7-01: copies the published guides from docs/ into site/docs/ before the site is built.
//
// docs/ stays the single source of truth; site/docs/ is generated and gitignored. Publication is an
// explicit allowlist, never a denylist: docs/baton, docs/research and docs/reports are internal
// records and must not leak when a new internal folder appears. A new guide is therefore published by
// adding it to GUIDES, and tests/site-build.test.ts fails until that is done.
//
//   tsx scripts/site/sync-docs.ts
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The user-facing guides, in sidebar order. Each is `docs/<name>.md`. */
export const GUIDES = [
  'getting-started',
  'cli-reference',
  'mcp-integration',
  'configuration',
  'architecture-rules',
  'framework-integration',
  'agent-best-practices',
  'architecture',
  'programmatic-usage',
  'adding-languages',
  'benchmarking',
] as const;

/** Folders of docs/ that guides reference. Only image files are copied from them, never Markdown. */
export const ASSET_DIRS = ['images'] as const;
export const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp)$/i;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The first level-one heading of a Markdown file, or the file name when it has none. */
export function guideTitle(markdown: string, fallback: string): string {
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    const m = !fenced && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return fallback;
}

/** Copies the guides and asset folders into `<site>/docs/` and writes its index. Returns the guide names. */
export function syncDocs(root: string = ROOT): string[] {
  const src = join(root, 'docs');
  const out = join(root, 'site', 'docs');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const titles: { name: string; title: string }[] = [];
  for (const name of GUIDES) {
    const from = join(src, `${name}.md`);
    if (!existsSync(from)) throw new Error(`docs/${name}.md is listed in GUIDES but does not exist`);
    const text = readFileSync(from, 'utf8');
    writeFileSync(join(out, `${name}.md`), text);
    titles.push({ name, title: guideTitle(text, name) });
  }
  for (const dir of ASSET_DIRS) {
    const from = join(src, dir);
    if (existsSync(from)) {
      cpSync(from, join(out, dir), {
        recursive: true,
        filter: (path) => statSync(path).isDirectory() || ASSET_EXTENSIONS.test(path),
      });
    }
  }

  const list = titles.map((t) => `- [${t.title}](./${t.name})`).join('\n');
  writeFileSync(
    join(out, 'index.md'),
    `---\ntitle: Documentation\n---\n\n# Documentation\n\nGuides for installing, configuring and using MapX.\n\n${list}\n`,
  );
  return titles.map((t) => t.name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = syncDocs();
  console.log(`site/docs: ${names.length} guides`);
}
