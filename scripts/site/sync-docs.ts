// M7-01: copies the published guides from docs/ into site/docs/ before the site is built.
//
// docs/ stays the single source of truth; site/docs/ is generated and gitignored. Publication is an
// explicit allowlist, never a denylist: docs/baton, docs/research and docs/reports are internal
// records and must not leak when a new internal folder appears. A new guide is therefore published by
// adding it to GUIDE_META, and tests/site-build.test.ts fails until that is done.
//
// Links in the guides are written for the repository (`../README.md`, `../.mapx/architecture.jsonc`).
// On the site a link to a repo file that is not published becomes a GitHub URL, and a link to a file
// that does not exist stops the sync with the guide and the line (M7-02).
//
//   tsx scripts/site/sync-docs.ts
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GuideMeta {
  /** `docs/<name>.md`, and the page `/docs/<name>`. */
  name: string;
  /** The sidebar entry. */
  label: string;
  /** The sidebar group; guides of one group are listed together, in this order. */
  group: string;
  /** The page's meta and Open Graph description: 50 to 160 characters, different for every page. */
  description: string;
}

/** The user-facing guides, in sidebar order. */
export const GUIDE_META: readonly GuideMeta[] = [
  { name: 'getting-started', label: 'Getting started', group: 'Start', description: 'Install MapX, index your first project and ask the graph about symbols, callers, dependencies and impact, from the CLI or an MCP client.' },
  { name: 'cli-reference', label: 'CLI reference', group: 'Reference', description: 'Every MapX command and flag: scan, sync, query, deps, impact, routes, export, architecture rules, the dashboard and more.' },
  { name: 'mcp-integration', label: 'MCP integration', group: 'Reference', description: 'Run MapX as an MCP server over stdio or SSE, connect Claude, Cursor or VS Code, and see every tool with its parameters.' },
  { name: 'configuration', label: 'Configuration', group: 'Reference', description: 'Configure MapX: config.json, include and exclude patterns, parallel parsing, gitignored files, workspaces and multi-repo setups.' },
  { name: 'architecture-rules', label: 'Architecture rules', group: 'Architecture rules', description: 'Declare layers and allow rules in .mapx/architecture.jsonc, enforce them in CI with mapx check, and read the reports, baselines and presets.' },
  { name: 'framework-integration', label: 'Framework integration', group: 'Guides', description: 'How MapX detects frameworks, extracts routes, hooks and HTTP calls, and pairs frontend calls with the backend routes they reach.' },
  { name: 'agent-best-practices', label: 'Agent best practices', group: 'Guides', description: 'Instruct coding agents such as Claude, Cursor, Cline and Aider to use MapX for fewer tokens and more precise code search.' },
  { name: 'programmatic-usage', label: 'Programmatic usage', group: 'Guides', description: 'Embed MapX in your own tools: scan a codebase, query symbols, trace data flow and analyse change impact through its TypeScript API.' },
  { name: 'adding-languages', label: 'Adding languages', group: 'Guides', description: 'Add a language to MapX with a tree-sitter grammar and query files, or write a dedicated parser for it.' },
  { name: 'architecture', label: 'How MapX works', group: 'Internals', description: 'How MapX works inside: the scanner, the SQLite graph, the parsers, name resolution, clusters and architecture classification.' },
  { name: 'benchmarking', label: 'Benchmarking', group: 'Internals', description: 'Measure how many tokens MapX saves compared with reading files, using the built-in benchmark suite and its recorded results.' },
];

/** The guide names, in sidebar order. */
export const GUIDES: readonly string[] = GUIDE_META.map((g) => g.name);

/** The repository's files on GitHub: where a link to an unpublished file goes. */
/** The description of the generated docs index page. */
export const DOCS_INDEX_DESCRIPTION = 'Guides for installing, configuring and using MapX: the CLI and MCP reference, architecture rules and integrations.';

/** The branch the live site is built from (pages.yml deploys it): links to the repository point at it. */
export const REPO_BRANCH = 'develop';
export const REPO_URL = 'https://github.com/MohamedGamil/mapx';
export const REPO_BLOB = `${REPO_URL}/blob/${REPO_BRANCH}/`;
export const REPO_TREE = `${REPO_URL}/tree/${REPO_BRANCH}/`;
export const REPO_EDIT = `${REPO_URL}/edit/${REPO_BRANCH}/`;

/** Folders of docs/ that guides reference. Only image files are copied from them, never Markdown. */
export const ASSET_DIRS = ['images'] as const;
export const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp)$/i;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
const TARGET = String.raw`(<[^>\n]*>|[^)\s]+)`;
/** `![alt](target "title")`: the target is group 1. */
const IMAGE = new RegExp(String.raw`!\[[^\]]*\]\(${TARGET}${TITLE}\s*\)`, 'dg');
/** `[text](target "title")`, where the text may hold an image (a linked image): the target is group 2. */
const LINK = new RegExp(String.raw`(?<!!)\[((?:!\[[^\]]*\]\([^)]*\)|\[[^\[\]]*\]|[^\[\]])*)\]\(${TARGET}${TITLE}\s*\)`, 'dg');
/** `[label]: target`, also in a list item or a blockquote; not a footnote (`[^1]: text`). */
const REF_DEF = /^((?:[ \t]*>)*[ \t]*(?:[-*+][ \t]+)?\[[^\]^][^\]]*\]:[ \t]*)(<[^>\n]*>|\S+)/d;
const SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;
const MASK = '\u0000';

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Whether git tracks `rel` (a file, or a folder holding tracked files). Outside a git checkout: true. */
function trackedByGit(root: string, rel: string): boolean {
  if (!existsSync(join(root, '.git'))) return true;
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
  } catch {
    return true;
  }
}

/**
 * Rewrites the links of one guide for the site. External links, in-page anchors and links to another
 * published guide stay as they are, and so do images under `./images/` (copied beside the guides). A
 * link to any other repository file becomes a GitHub URL (`blob` for a file, `tree` for a folder), and
 * a link to a file that does not exist, that git does not track (GitHub has no page for it), or that
 * leaves the repository, throws with `docs/<guide>.md:<line>`. Fenced code, inline code and HTML
 * comments are not links and are left untouched.
 *
 * It does not check a `#fragment` on a link to a guide: the site's own heading ids are checked by
 * tests/site-docs.test.ts against the built pages, and the repository's by tests/docs-surface.test.ts.
 */
export function rewriteLinks(markdown: string, guide: string, root: string, published: readonly string[]): string {
  const docsDir = join(root, 'docs');
  const fail = (line: number, target: string, why: string): never => {
    throw new Error(`docs/${guide}.md:${line}: link ${target} ${why}`);
  };

  const fix = (raw: string, isImage: boolean, line: number): string => {
    const angle = raw.startsWith('<') && raw.endsWith('>');
    const target = angle ? raw.slice(1, -1) : raw;
    if (SCHEME.test(target)) return raw;
    const cut = target.search(/[?#]/);
    const path = cut === -1 ? target : target.slice(0, cut);
    const suffix = cut === -1 ? '' : target.slice(cut);
    if (path === '') return raw;
    if (isImage && /^(?:\.\/)?images\//.test(path)) return raw;
    if (published.includes(path.replace(/^\.\//, '').replace(/\.md$/i, ''))) return raw;
    const resolved = resolve(docsDir, safeDecode(path));
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return fail(line, target, 'leaves the repository');
    if (!existsSync(resolved)) return fail(line, target, 'does not exist');
    if (rel !== '' && !trackedByGit(root, rel)) return fail(line, target, 'is not tracked by git, so GitHub has no page for it');
    const url = encodeURI(rel.split(sep).join('/'));
    return `${statSync(resolved).isDirectory() ? REPO_TREE : REPO_BLOB}${url}${suffix}`;
  };

  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  const out = markdown.split('\n').map((text, i) => {
    const n = i + 1;
    const open = FENCE.exec(text);
    if (fence) {
      // A closing fence: the same character, at least as long, and nothing after it.
      if (open && open[1]![0] === fence.char && open[1]!.length >= fence.length && /^(?:[ \t]*>)*[ \t]*[`~]+[ \t]*$/.test(text)) fence = null;
      return text;
    }
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      return text;
    }
    // Text that is not a link is masked, character for character, so match positions stay valid:
    // inline code first (it may hold `<!--`), then HTML comments, which may span lines.
    let masked = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => MASK.repeat(m.length));
    let visible = '';
    for (let rest = masked; rest.length; ) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) { visible += MASK.repeat(rest.length); break; }
        inComment = false;
        visible += MASK.repeat(end + 3);
        rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) { visible += rest; break; }
        inComment = true;
        visible += rest.slice(0, start) + MASK.repeat(4);
        rest = rest.slice(start + 4);
      }
    }
    masked = visible;

    const patches: { from: number; to: number; text: string }[] = [];
    const add = (m: RegExpMatchArray, group: number, isImage: boolean) => {
      const [from, to] = (m as RegExpMatchArray & { indices: [number, number][] }).indices[group]!;
      patches.push({ from, to, text: fix(text.slice(from, to), isImage, n) });
    };
    for (const m of masked.matchAll(IMAGE)) add(m, 1, true);
    for (const m of masked.matchAll(LINK)) add(m, 2, false);
    const def = REF_DEF.exec(masked);
    if (def) add(def, 2, false);

    let result = text;
    for (const p of patches.sort((a, b) => b.from - a.from)) result = result.slice(0, p.from) + p.text + result.slice(p.to);
    return result;
  });
  return out.join('\n');
}

/** Copies the guides and asset folders into `<site>/docs/` and writes its index. Returns the guide names. */
export function syncDocs(root: string = ROOT, guides: readonly GuideMeta[] = GUIDE_META): string[] {
  const src = join(root, 'docs');
  const out = join(root, 'site', 'docs');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const names = guides.map((g) => g.name);
  for (const { name, description } of guides) {
    const from = join(src, `${name}.md`);
    if (!existsSync(from)) throw new Error(`docs/${name}.md is listed in GUIDE_META but does not exist`);
    const text = rewriteLinks(readFileSync(from, 'utf8'), name, root, names);
    if (text.startsWith('---\n')) throw new Error(`docs/${name}.md has front matter of its own; the sync writes the description`);
    // JSON strings are valid YAML double-quoted scalars.
    writeFileSync(join(out, `${name}.md`), `---\ndescription: ${JSON.stringify(description)}\n---\n\n${text}`);
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

  const groups = [...new Set(guides.map((g) => g.group))];
  const list = groups
    .map((group) => `## ${group}\n\n${guides.filter((g) => g.group === group).map((g) => `- [${g.label}](./${g.name})`).join('\n')}`)
    .join('\n\n');
  writeFileSync(
    join(out, 'index.md'),
    `---\ntitle: Documentation\ndescription: ${JSON.stringify(DOCS_INDEX_DESCRIPTION)}\neditLink: false\n---\n\n# Documentation\n\nGuides for installing, configuring and using MapX.\n\n${list}\n`,
  );
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = syncDocs();
  console.log(`site/docs: ${names.length} guides`);
}
