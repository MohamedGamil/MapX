// The element view of the index (M5-03; docs/research/deptrac AR-01): one element per indexed file
// and per symbol, each with a qualified name, its file's repo, language, role and clusters, and the
// framework parts its stored edges imply. Selectors (src/arch/selectors) and layer membership
// (src/arch/membership.ts) evaluate over it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Store } from '../core/store.js';
import type { FRAMEWORK_PARTS } from './schema.js';

export type FrameworkPart = typeof FRAMEWORK_PARTS[number];

export interface FileInfo {
  path: string;
  repo: string;
  language: string;
  role: string | null;
  roleConfidence: number;
  clusters: string[];
  frameworkParts: Set<FrameworkPart>;
  /** The namespace or package the language declares (PHP, Java, C#, Go …), or null. */
  namespace: string | null;
}

export interface Element {
  /** `file:<path>`, or `symbol:<path>#<qualifiedName>#<kind>` (overloads share one element). */
  id: string;
  kind: 'file' | 'symbol';
  qualifiedName: string;
  file: FileInfo;
  /** The symbol's own name, kind and enclosing scope; absent for files. */
  name?: string;
  symbolKind?: string;
  scope?: string | null;
  /** A symbol declared at file level (not inside a class or function). */
  topLevel: boolean;
}

export interface ElementView {
  elements: Element[];
  files: Map<string, FileInfo>;
  byId: Map<string, Element>;
  /** The file's element, then its symbols. */
  ofFile(path: string): Element[];
  /** Nearest manifest name (package.json, composer.json, pyproject.toml, go.mod, Cargo.toml) for a file; read lazily. */
  workspacePackage(path: string): string | null;
  /** Identifies the scan the view was built from (M5-03 memoisation). */
  scanStamp: string;
}

// ─── Qualified names (AR-01) ─────────────────────────────────────────────────────────────────

/**
 * How each language spells a qualified name. `namespace` languages join the declared namespace or
 * package, the enclosing scope and the name with their separator; `module` languages derive the
 * module from the path; `scoped` languages nest modules as symbols; the rest fall back to
 * `path#Scope.Name`, which is unique within a workspace.
 */
export const QUALIFIED_NAME_RULES: Record<string, { style: 'namespace' | 'python' | 'go' | 'rust' | 'scoped' | 'path'; sep?: string; scopeSep?: string }> = {
  php: { style: 'namespace', sep: '\\', scopeSep: '::' },
  java: { style: 'namespace', sep: '.' },
  kotlin: { style: 'namespace', sep: '.' },
  scala: { style: 'namespace', sep: '.' },
  'c-sharp': { style: 'namespace', sep: '.' },
  dart: { style: 'namespace', sep: '.' },
  cpp: { style: 'namespace', sep: '::' },
  python: { style: 'python' },
  go: { style: 'go' },
  rust: { style: 'rust' },
  ruby: { style: 'scoped', sep: '::' },
  elixir: { style: 'scoped', sep: '.' },
  // Path-based: JS/TS (and their component formats), and languages without a namespace in the source.
  javascript: { style: 'path' }, typescript: { style: 'path' }, tsx: { style: 'path' }, vue: { style: 'path' }, svelte: { style: 'path' },
  swift: { style: 'path' }, c: { style: 'path' }, lua: { style: 'path' }, zig: { style: 'path' }, bash: { style: 'path' },
  fish: { style: 'path' }, pascal: { style: 'path' }, markdown: { style: 'path' }, html: { style: 'path' }, css: { style: 'path' },
  json: { style: 'path' }, yaml: { style: 'path' },
};

export interface QualifiedNameInput {
  path: string;
  /** Declared namespace or package; for Go the import path (module + directory); for Python the module. */
  namespace?: string | null;
  /** For symbols: name, enclosing scope. A file has neither. */
  name?: string;
  scope?: string | null;
  /** The repo's path inside the workspace, so module paths start at the repo (Python, Rust). */
  repoPath?: string;
}

/** The module a Python file is: `app/services/foo.py` → `app.services.foo` (`src/` and `__init__` dropped). */
export function pythonModule(path: string, repoPath = '.'): string {
  let rel = repoPath && repoPath !== '.' && path.startsWith(repoPath.replace(/\/$/, '') + '/') ? path.slice(repoPath.replace(/\/$/, '').length + 1) : path;
  rel = rel.replace(/\.pyw?$/, '').replace(/(^|\/)__init__$/, '');
  if (rel.startsWith('src/')) rel = rel.slice(4);
  return rel.split('/').filter(Boolean).join('.');
}

/** The Rust module path of a file: `src/a/b.rs` → `crate::a::b` (`lib.rs`, `main.rs`, `mod.rs` name their directory). */
export function rustModule(path: string, repoPath = '.'): string {
  let rel = repoPath && repoPath !== '.' && path.startsWith(repoPath.replace(/\/$/, '') + '/') ? path.slice(repoPath.replace(/\/$/, '').length + 1) : path;
  rel = rel.replace(/\.rs$/, '').replace(/^src\//, '').replace(/(^|\/)(lib|main|mod)$/, '');
  return ['crate', ...rel.split('/').filter(Boolean)].join('::');
}

/**
 * The qualified name of a file (`name` absent) or symbol in `language`. Examples: PHP
 * `App\Domain\Order::run`, Java `com.acme.Order.run`, Go `example.com/shop/domain.Order.Run`,
 * Python `app.domain.order.Order.run`, Rust `crate::domain::Order::run`, Ruby `Billing::Invoice`,
 * TypeScript `src/domain/Order.ts#Order.run`.
 */
export function qualifiedName(language: string, input: QualifiedNameInput): string {
  const rule = QUALIFIED_NAME_RULES[language] ?? { style: 'path' as const };
  const { path, name, scope } = input;
  const ns = input.namespace || null;
  const join = (prefix: string | null, sep: string, scopeSep = sep) =>
    name === undefined ? (prefix ?? path) : [prefix, scope ? `${scope}${scopeSep}${name}` : name].filter(Boolean).join(sep);
  switch (rule.style) {
    case 'namespace':
      if (!ns) return name === undefined ? path : `${path}#${scope ? `${scope}.` : ''}${name}`;
      return join(ns, rule.sep!, rule.scopeSep ?? rule.sep!);
    case 'python':
      return join(ns ?? pythonModule(path, input.repoPath), '.');
    case 'go':
      return join(ns ?? posix.dirname(path), '.');
    case 'rust':
      return join(ns ?? rustModule(path, input.repoPath), '::');
    case 'scoped':
      return name === undefined ? path : scope ? `${scope}${rule.sep}${name}` : name;
    default:
      return name === undefined ? path : `${path}#${scope ? `${scope}.` : ''}${name}`;
  }
}

// ─── Building the view ───────────────────────────────────────────────────────────────────────

/** Framework parts implied by stored edges (AR-04): which end of which edge type. */
const FRAMEWORK_EDGES: Array<{ type: string; end: 'source' | 'target'; part: FrameworkPart }> = [
  { type: 'route', end: 'target', part: 'route-handler' },
  { type: 'http', end: 'target', part: 'route-handler' },
  { type: 'middleware', end: 'target', part: 'middleware' },
  { type: 'relation', end: 'source', part: 'model' },
  { type: 'dispatch', end: 'target', part: 'job' },
  { type: 'dispatch', end: 'target', part: 'event' },
  { type: 'notify', end: 'target', part: 'listener' },
  { type: 'graphql_resolver', end: 'target', part: 'resolver' },
  { type: 'render', end: 'target', part: 'component' },
  { type: 'http', end: 'source', part: 'http-client' },
];

/** Languages whose files declare their namespace as a `namespace` symbol (package, namespace clause). */
const NAMESPACE_SYMBOL_LANGUAGES = new Set(['java', 'kotlin', 'scala', 'c-sharp', 'dart', 'cpp']);

/** The view of the index in `store`; `dir` is the workspace root (for go.mod and manifests). */
export function buildElementView(store: Store, dir: string, repoPaths: Record<string, string> = {}): ElementView {
  const db = store.raw;
  const fileRows = db.prepare('SELECT path, repo, language, namespace, role, role_confidence FROM files').all() as Array<{ path: string; repo: string; language: string; namespace: string | null; role: string | null; role_confidence: number | null }>;
  const clusterRows = db.prepare('SELECT file_path, cluster_name FROM cluster_membership').all() as Array<{ file_path: string; cluster_name: string }>;
  const symbolRows = db.prepare('SELECT file_path, name, kind, scope FROM symbols ORDER BY file_path, start_line').all() as Array<{ file_path: string; name: string; kind: string; scope: string | null }>;
  const clusters = new Map<string, string[]>();
  for (const r of clusterRows) {
    const list = clusters.get(r.file_path) ?? [];
    list.push(r.cluster_name);
    clusters.set(r.file_path, list);
  }
  const parts = new Map<string, Set<FrameworkPart>>();
  for (const { type, end, part } of FRAMEWORK_EDGES) {
    const col = end === 'source' ? 'source_file' : 'target_file';
    for (const r of db.prepare(`SELECT DISTINCT ${col} AS f FROM edges WHERE edge_type = ?`).all(type) as Array<{ f: string }>) {
      const set = parts.get(r.f) ?? new Set<FrameworkPart>();
      set.add(part);
      parts.set(r.f, set);
    }
  }
  const declared = new Map<string, string>();
  for (const s of symbolRows) {
    if (s.kind === 'namespace' && !declared.has(s.file_path)) declared.set(s.file_path, s.name);
  }

  const goModules = new Map<string, { root: string; module: string } | null>();
  const goModuleOf = (path: string): { root: string; module: string } | null => {
    let d = dirname(path);
    const seen: string[] = [];
    for (;;) {
      if (goModules.has(d)) { const hit = goModules.get(d)!; for (const s of seen) goModules.set(s, hit); return hit; }
      seen.push(d);
      const mod = join(dir, d, 'go.mod');
      if (existsSync(mod)) {
        const m = /^module\s+(\S+)/m.exec(readFileSync(mod, 'utf8'));
        const hit = m ? { root: d, module: m[1]! } : null;
        for (const s of seen) goModules.set(s, hit);
        return hit;
      }
      if (d === '.' || d === '/' || d === '') { for (const s of seen) goModules.set(s, null); return null; }
      d = dirname(d);
    }
  };

  const files = new Map<string, FileInfo>();
  for (const f of fileRows) {
    let namespace: string | null = null;
    if (f.language === 'php') namespace = f.namespace || null;
    else if (NAMESPACE_SYMBOL_LANGUAGES.has(f.language)) namespace = declared.get(f.path) ?? null;
    else if (f.language === 'go') {
      const mod = goModuleOf(f.path);
      const fileDir = posix.dirname(f.path);
      if (mod) {
        const rel = mod.root === '.' ? fileDir : posix.relative(mod.root, fileDir);
        namespace = rel === '.' || rel === '' ? mod.module : `${mod.module}/${rel}`;
      }
    }
    files.set(f.path, {
      path: f.path, repo: f.repo, language: f.language, role: f.role, roleConfidence: f.role_confidence ?? 0,
      clusters: clusters.get(f.path) ?? [], frameworkParts: parts.get(f.path) ?? new Set(), namespace,
    });
  }

  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byFile = new Map<string, Element[]>();
  const add = (e: Element) => {
    if (byId.has(e.id)) return;
    byId.set(e.id, e);
    elements.push(e);
    const list = byFile.get(e.file.path) ?? [];
    list.push(e);
    byFile.set(e.file.path, list);
  };
  for (const file of files.values()) {
    const repoPath = repoPaths[file.repo];
    add({ id: `file:${file.path}`, kind: 'file', qualifiedName: qualifiedName(file.language, { path: file.path, namespace: file.namespace, repoPath }), file, topLevel: false });
  }
  for (const s of symbolRows) {
    const file = files.get(s.file_path);
    if (!file || s.kind === 'namespace') continue; // a package clause names the file's namespace, not an element
    const qn = qualifiedName(file.language, { path: file.path, namespace: file.namespace, name: s.name, scope: s.scope, repoPath: repoPaths[file.repo] });
    add({ id: `symbol:${file.path}#${qn}#${s.kind}`, kind: 'symbol', qualifiedName: qn, file, name: s.name, symbolKind: s.kind, scope: s.scope, topLevel: !s.scope });
  }

  const manifests = new Map<string, string | null>();
  const manifestName = (d: string): string | null => {
    if (manifests.has(d)) return manifests.get(d)!;
    const read = (f: string) => { try { return readFileSync(join(dir, d, f), 'utf8'); } catch { return null; } };
    let name: string | null = null;
    const pkg = read('package.json');
    if (pkg) { try { name = JSON.parse(pkg).name ?? null; } catch { /* not JSON */ } }
    const composer = name ? null : read('composer.json');
    if (composer) { try { name = JSON.parse(composer).name ?? null; } catch { /* not JSON */ } }
    const pyproject = name ? null : read('pyproject.toml');
    if (pyproject) name = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? null;
    const gomod = name ? null : read('go.mod');
    if (gomod) name = /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null;
    const cargo = name ? null : read('Cargo.toml');
    if (cargo) name = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? null;
    manifests.set(d, name);
    return name;
  };
  const packages = new Map<string, string | null>();
  const workspacePackage = (path: string): string | null => {
    if (packages.has(path)) return packages.get(path)!;
    let d = posix.dirname(path);
    let found: string | null = null;
    for (;;) {
      const name = manifestName(d);
      if (name) { found = name; break; }
      if (d === '.' || d === '') break;
      d = posix.dirname(d);
    }
    packages.set(path, found);
    return found;
  };

  const stamp = [
    store.getMeta('last_scan_time') ?? '',
    fileRows.length,
    symbolRows.length,
    (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n,
  ].join(':');

  return { elements, files, byId, ofFile: (p) => byFile.get(p) ?? [], workspacePackage, scanStamp: stamp };
}
