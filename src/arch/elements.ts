// The element view of the index (M5-03; docs/research/deptrac AR-01): one element per indexed file
// and per symbol, each with a qualified name, its file's repo, language, role and clusters, and the
// framework parts its stored edges imply. Selectors (src/arch/selectors) and layer membership
// (src/arch/membership.ts) evaluate over it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Store } from '../core/store.js';
import type { FRAMEWORK_PARTS } from './schema.js';
import type { SymbolDecorator, SymbolDocTag } from '../types.js';

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
  /**
   * `file:<path>`, `symbol:<path>#<qualifiedName>#<kind>` (overloads share one element), or for
   * something outside the workspace `external:<ecosystem>:<origin>:<name>:<direct>:<dev>` (M5-24).
   */
  id: string;
  kind: 'file' | 'symbol' | 'external';
  qualifiedName: string;
  file: FileInfo;
  /** The symbol's own name, kind and enclosing scope; absent for files. */
  name?: string;
  symbolKind?: string;
  scope?: string | null;
  /** A symbol declared at file level (not inside a class or function). */
  topLevel: boolean;
  /** A symbol's decorators, attributes or annotations, and doc tags, as parsed (M5-10); absent when none. */
  decorators?: SymbolDecorator[];
  docTags?: SymbolDocTag[];
  /** A symbol's restricted native visibility (Kotlin/C# `internal`, Java `package`, Rust `pub(crate)` …; M5-11). */
  visibility?: string;
  /** A type's declaration line as stored (its base list; M5-09); absent for other symbols. */
  signature?: string;
  /** The traits a PHP type uses, fully qualified (`metadata.mixins`; M5-09). */
  mixins?: string[];
  /** For an external element (M5-24): what the scan attributed its references to. */
  external?: ExternalInfo;
}

/**
 * An external element (M5-24): a package, a built-in or ambient access, as the `external_refs`
 * view attributes it (M5-19 to M5-23). Its name is the package (`pg`, `guzzlehttp/guzzle`), a
 * built-in's package (`node:fs`, `ext-pdo`, `python:os`, `net/http`), or for a package no input
 * names (`package` null) the specifier as written. `direct` and `dev` are per reference: one
 * package used as a direct dependency here and a transitive one there is two elements.
 */
export interface ExternalInfo {
  ecosystem: string;
  origin: 'package' | 'builtin' | 'ambient';
  name: string;
  package: string | null;
  direct: boolean | null;
  dev: boolean | null;
}

/** One stored reference to an external element (an `external_refs` row). */
export interface ExternalRef {
  file: string;
  line: number;
  sourceSymbol: string | null;
  /** The reference kind, used as the edge type: import, require, call, instantiation, extends … */
  kind: string;
  target: Element;
}

/** What the index records of inheritance (M5-09): the stored edges, and the references outside it. */
export interface InheritanceRecords {
  /** `extends` and `implements` edges, as stored. */
  edges: Array<{ sourceFile: string; sourceSymbol: string | null; targetFile: string; targetSymbol: string | null; type: 'extends' | 'implements' }>;
  /**
   * External-reference candidates (M5-19) that name a base: `extends` and `implements` ones (PHP's
   * FQN through `use`, a TS class's base), and the imports that name what a base is written as.
   */
  candidates: Array<{ file: string; sourceSymbol: string | null; specifier: string; symbol: string | null; kind: string }>;
}

export interface ElementView {
  /** The workspace directory the view's paths are relative to. */
  root: string;
  elements: Element[];
  files: Map<string, FileInfo>;
  byId: Map<string, Element>;
  /** The file's element, then its symbols. */
  ofFile(path: string): Element[];
  /** Nearest manifest name (package.json, composer.json, pyproject.toml, go.mod, Cargo.toml) for a file; read lazily. */
  workspacePackage(path: string): string | null;
  /** Identifies the scan the view was built from (M5-03 memoisation). */
  scanStamp: string;
  /** Inheritance as stored, for the hierarchy selectors and inherited dependencies (M5-09). */
  inheritance: InheritanceRecords;
  /**
   * External elements (M5-24), apart from `elements`: what file and symbol consumers iterate never
   * includes them. Layer membership and the evaluator read them. Absent in a synthetic view.
   */
  externals?: Element[];
  /** The stored references to them, in `external_refs` order. */
  externalRefs?: ExternalRef[];
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
  cpp: { style: 'scoped', sep: '::' },
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
  /** Where module paths start (Python, Rust): the package or crate root, else the repo's path. */
  repoPath?: string;
  /**
   * `scoped` languages (C++, Ruby, Elixir): the qualified name of the enclosing namespace, module
   * or type, found from the symbols' line ranges, since those parsers store no namespace.
   */
  parent?: { qualifiedName: string; name: string } | null;
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
    case 'scoped': {
      if (name === undefined) return path; // a file can declare several namespaces or modules
      const parent = input.parent ?? null;
      // The stored scope is the owner when the parser knows it (`void Order::run()` inside
      // `namespace acme::domain`, `class Billing::Receipt`); it repeats the parent otherwise.
      return [parent?.qualifiedName, scope && scope !== parent?.name ? scope : null, name].filter(Boolean).join(rule.sep);
    }
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
const NAMESPACE_SYMBOL_LANGUAGES = new Set(['java', 'kotlin', 'scala', 'c-sharp', 'dart']);

/** Symbols that enclose others in `scoped` languages, outermost rank first (ties on equal line ranges). */
const CONTAINER_RANK: Record<string, number> = { namespace: 0, module: 1, class: 2, struct: 2, interface: 2, trait: 2, enum: 2 };
/** Containers that act as namespaces: a symbol directly inside one is still declared at file level. */
const NAMESPACE_LIKE = new Set(['namespace', 'module']);
const RANK_TYPE = 2;

interface SymbolRow { file_path: string; name: string; kind: string; scope: string | null; start_line: number | null; end_line: number | null; metadata?: string | null; signature?: string | null }

/** Symbol kinds that declare a type, whose signature holds the base list (M5-09). */
export const TYPE_SYMBOL_KINDS = new Set(['class', 'interface', 'trait', 'struct', 'enum', 'module']);

/**
 * The innermost container of each symbol of one file, from line ranges: a container encloses a
 * symbol when its range covers the symbol's and is larger, or equal with an outer rank. On one
 * line, a type encloses only a symbol the parser scoped to it: `namespace a { class A {}; void f() {} }`
 * keeps `f` out of `A`.
 */
function enclosingContainers(rows: SymbolRow[]): Map<SymbolRow, SymbolRow | null> {
  const containers = rows.filter((r) => r.kind in CONTAINER_RANK && r.start_line != null && r.end_line != null);
  const out = new Map<SymbolRow, SymbolRow | null>();
  for (const s of rows) {
    let best: SymbolRow | null = null;
    if (s.start_line != null && s.end_line != null) {
      for (const c of containers) {
        if (c === s || c.start_line! > s.start_line || c.end_line! < s.end_line) continue;
        const span = c.end_line! - c.start_line!;
        const own = s.end_line - s.start_line;
        const rankS = CONTAINER_RANK[s.kind] ?? 3;
        if (span === own && CONTAINER_RANK[c.kind]! >= rankS) continue;
        if (span === 0 && CONTAINER_RANK[c.kind]! >= RANK_TYPE && s.scope !== c.name) continue;
        if (!best) { best = c; continue; }
        const bestSpan = best.end_line! - best.start_line!;
        if (span < bestSpan || (span === bestSpan && CONTAINER_RANK[c.kind]! > CONTAINER_RANK[best.kind]!)) best = c;
      }
    }
    out.set(s, best);
  }
  return out;
}

/** The view of the index in `store`; `dir` is the workspace root (for go.mod and manifests). */
/**
 * A cheap fingerprint of the scan an index holds. Every scan and sync writes
 * `last_scan_time:<repo>`, so a sync that keeps every count still changes it
 * (review 2026-11-02: the bare `last_scan_time` key is never written).
 */
export function scanStamp(store: Store): string {
  const db = store.raw;
  const times = (db.prepare("SELECT key, value FROM meta WHERE key LIKE 'last_scan_time%' ORDER BY key").all() as { key: string; value: string }[])
    .map((r) => `${r.key}=${r.value}`)
    .join(',');
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return [times, count('files'), count('symbols'), count('edges')].join(':');
}

/** The decorators, doc tags (M5-10), restricted visibility (M5-11) and PHP trait uses (M5-09) a symbol row's metadata holds. */
function annotationsOf(s: SymbolRow): { decorators?: SymbolDecorator[]; docTags?: SymbolDocTag[]; visibility?: string; mixins?: string[] } {
  if (!s.metadata || !(s.metadata.includes('"decorators"') || s.metadata.includes('"docTags"') || s.metadata.includes('"visibility"') || s.metadata.includes('"mixins"'))) return {};
  try {
    const m = JSON.parse(s.metadata) as { decorators?: unknown; docTags?: unknown; visibility?: unknown; mixins?: unknown };
    return {
      ...(Array.isArray(m.decorators) && m.decorators.length ? { decorators: m.decorators as SymbolDecorator[] } : {}),
      ...(Array.isArray(m.docTags) && m.docTags.length ? { docTags: m.docTags as SymbolDocTag[] } : {}),
      ...(typeof m.visibility === 'string' && m.visibility ? { visibility: m.visibility } : {}),
      ...(Array.isArray(m.mixins) && m.mixins.length ? { mixins: m.mixins.filter((x): x is string => typeof x === 'string') } : {}),
    };
  } catch {
    return {};
  }
}

const hasTable = (store: Store, name: string) => !!store.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function buildElementView(store: Store, dir: string, repoPaths: Record<string, string> = {}): ElementView {
  const db = store.raw;
  const fileRows = db.prepare('SELECT path, repo, language, namespace, role, role_confidence FROM files').all() as Array<{ path: string; repo: string; language: string; namespace: string | null; role: string | null; role_confidence: number | null }>;
  const clusterRows = db.prepare('SELECT file_path, cluster_name FROM cluster_membership').all() as Array<{ file_path: string; cluster_name: string }>;
  const symbolRows = db.prepare('SELECT file_path, name, kind, scope, start_line, end_line, metadata, signature FROM symbols ORDER BY file_path, start_line').all() as unknown as SymbolRow[];
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

  // The nearest directory holding one of `markers` (a package or crate root), cached per directory.
  const markerDirs = new Map<string, string | null>();
  const nearestWith = (path: string, markers: string[]): string | null => {
    let d = posix.dirname(path);
    const seen: string[] = [];
    let found: string | null = null;
    for (;;) {
      const key = `${markers.join(',')}\u0000${d}`;
      if (markerDirs.has(key)) { found = markerDirs.get(key)!; break; }
      seen.push(key);
      if (markers.some((m) => existsSync(join(dir, d, m)))) { found = d; break; }
      if (d === '.' || d === '' || d === '/') break;
      d = posix.dirname(d);
    }
    for (const k of seen) markerDirs.set(k, found);
    return found;
  };
  /** Where a Python or Rust file's module path starts: its package or crate root, else its repo. */
  const moduleRoot = (file: FileInfo): string | undefined => {
    const markers = file.language === 'python' ? ['pyproject.toml', 'setup.py', 'setup.cfg'] : file.language === 'rust' ? ['Cargo.toml'] : null;
    if (!markers) return repoPaths[file.repo];
    return nearestWith(file.path, markers) ?? repoPaths[file.repo];
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
    const known = byId.get(e.id);
    if (known) {
      // Overloads share one element: it carries all their decorators and doc tags (M5-10).
      if (e.decorators) known.decorators = [...(known.decorators ?? []), ...e.decorators];
      if (e.docTags) known.docTags = [...(known.docTags ?? []), ...e.docTags];
      // A restricted visibility only when every overload has it: a public overload is reachable (M5-11).
      if (known.visibility !== e.visibility) delete known.visibility;
      return;
    }
    byId.set(e.id, e);
    elements.push(e);
    const list = byFile.get(e.file.path) ?? [];
    list.push(e);
    byFile.set(e.file.path, list);
  };
  const roots = new Map<string, string | undefined>();
  for (const file of files.values()) {
    const repoPath = moduleRoot(file);
    roots.set(file.path, repoPath);
    add({ id: `file:${file.path}`, kind: 'file', qualifiedName: qualifiedName(file.language, { path: file.path, namespace: file.namespace, repoPath }), file, topLevel: false });
  }
  const rowsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbolRows) {
    const list = rowsByFile.get(s.file_path) ?? [];
    list.push(s);
    rowsByFile.set(s.file_path, list);
  }
  for (const [path, rows] of rowsByFile) {
    const file = files.get(path);
    if (!file) continue;
    const scoped = QUALIFIED_NAME_RULES[file.language]?.style === 'scoped';
    const parents = scoped ? enclosingContainers(rows) : null;
    // C# and Scala store each declaration's own namespace (blocks, nested packages, the global
    // namespace as ''); other rows, and indexes from before M5-03-R2, take the file's (M5-03-R2).
    const namespaceOf = (s: SymbolRow): string | null => {
      if (!s.metadata || !s.metadata.includes('"namespace"')) return file.namespace;
      try {
        const ns = (JSON.parse(s.metadata) as { namespace?: unknown }).namespace;
        return typeof ns === 'string' ? ns || null : file.namespace;
      } catch {
        return file.namespace;
      }
    };
    const qns = new Map<SymbolRow, string>();
    // Ruby `class ::Top::Thing` is scoped to `::Top`: the leading `::` names the root, not a module.
    const scopeOf = (s: SymbolRow) => (scoped && s.scope ? s.scope.replace(/^::/, '') : s.scope);
    const typesByName = new Map<string, SymbolRow[]>();
    if (scoped) for (const r of rows) if ((CONTAINER_RANK[r.kind] ?? -1) >= RANK_TYPE) typesByName.set(r.name, [...(typesByName.get(r.name) ?? []), r]);
    const qnOf = (s: SymbolRow, depth = 0): string => {
      let qn = qns.get(s);
      if (qn !== undefined) return qn;
      let parent = depth < 64 ? parents?.get(s) ?? null : null;
      const scope = scopeOf(s);
      // An out-of-line member (`void acme::Outer::g() {}`, stored as scope `Outer`): when the file
      // declares that type, the member is named under the type's own qualified name.
      if (scoped && scope && scope !== parent?.name && depth < 64) {
        const owners = (typesByName.get(scope) ?? []).filter((o) => o !== s);
        if (owners.length === 1) parent = owners[0]!;
      }
      qn = qualifiedName(file.language, {
        path, namespace: namespaceOf(s), name: s.name, scope, repoPath: roots.get(path),
        parent: parent ? { qualifiedName: qnOf(parent, depth + 1), name: parent.name } : null,
      });
      qns.set(s, qn);
      return qn;
    };
    for (const s of rows) {
      if (s.kind === 'namespace') continue; // a package clause or namespace names a scope, not an element
      const qn = qnOf(s);
      const parent = parents?.get(s) ?? null;
      const scope = scopeOf(s);
      // Declared at file level: not inside a type, and not a member the parser scoped to a type. A
      // type's scope can be a namespace qualifier (Ruby `class Billing::Receipt`), and a declaration
      // directly in a namespace or module is scoped to it (C++ `namespace d { using Id = long; }`).
      // An Elixir module is a type, not a namespace: its functions are members, but a nested
      // `defmodule` is a module of its own.
      const namespaceLike = (c: SymbolRow) => NAMESPACE_LIKE.has(c.kind) && !(file.language === 'elixir' && s.kind !== 'module');
      const scopedToNamespace = !!parent && namespaceLike(parent) && parent.name === scope;
      const topLevel = scoped
        ? (!parent || namespaceLike(parent)) && !(scope && !(s.kind in CONTAINER_RANK) && !scopedToNamespace)
        : !s.scope;
      const signature = TYPE_SYMBOL_KINDS.has(s.kind) && s.signature ? { signature: s.signature } : {};
      add({ id: `symbol:${file.path}#${qn}#${s.kind}`, kind: 'symbol', qualifiedName: qn, file, name: s.name, symbolKind: s.kind, scope: s.scope, topLevel, ...signature, ...annotationsOf(s) });
    }
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

  const stamp = scanStamp(store);

  // Inheritance (M5-09): the stored edges, and the candidates that name bases outside the index.
  const inheritance: InheritanceRecords = {
    edges: (db.prepare("SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE edge_type IN ('extends', 'implements') ORDER BY id").all() as Array<{ source_file: string; source_symbol: string | null; target_file: string; target_symbol: string | null; edge_type: 'extends' | 'implements' }>)
      .map((r) => ({ sourceFile: r.source_file, sourceSymbol: r.source_symbol, targetFile: r.target_file, targetSymbol: r.target_symbol, type: r.edge_type })),
    candidates: hasTable(store, 'external_ref_candidates')
      ? (db.prepare("SELECT file_path, source_symbol, specifier, symbol, kind FROM external_ref_candidates WHERE kind IN ('extends', 'implements', 'import') ORDER BY id").all() as Array<{ file_path: string; source_symbol: string | null; specifier: string; symbol: string | null; kind: string }>)
        .map((r) => ({ file: r.file_path, sourceSymbol: r.source_symbol, specifier: r.specifier, symbol: r.symbol, kind: r.kind }))
      : [],
  };

  const { externals, externalRefs } = externalElements(store);
  return { root: dir, elements, files, byId, ofFile: (p) => byFile.get(p) ?? [], workspacePackage, scanStamp: stamp, inheritance, externals, externalRefs };
}

/** The file an external element is judged by: none. File and symbol selectors never apply to it. */
const NO_FILE: FileInfo = { path: '', repo: '', language: '', role: null, roleConfidence: 0, clusters: [], frameworkParts: new Set(), namespace: null };

/** The ecosystem-qualified name `mapx arch allowed` accepts for an external: `npm:pg`, `go:fmt`. */
export const externalKey = (e: ExternalInfo) => `${e.ecosystem}:${e.name}`;

/** External elements and their references, from the `external_refs` view (M5-19; M5-24). */
function externalElements(store: Store): { externals: Element[]; externalRefs: ExternalRef[] } {
  const db = store.raw;
  const has = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'external_refs'").get();
  if (!has) return { externals: [], externalRefs: [] };
  const rows = db.prepare('SELECT file_path, line, source_symbol, specifier, kind, ecosystem, package, origin, direct, dev FROM external_refs ORDER BY id').all() as Array<{
    file_path: string; line: number; source_symbol: string | null; specifier: string; kind: string; ecosystem: string;
    package: string | null; origin: string | null; direct: number | null; dev: number | null;
  }>;
  const byId = new Map<string, Element>();
  const externalRefs: ExternalRef[] = [];
  const flag = (n: number | null) => (n === null || n === undefined ? null : n === 1);
  for (const r of rows) {
    // A row M5-19 stored before attribution (origin null) is a package no input names yet.
    const origin = r.origin === 'builtin' || r.origin === 'ambient' ? r.origin : 'package';
    const name = r.package ?? r.specifier;
    const info: ExternalInfo = { ecosystem: r.ecosystem, origin, name, package: r.package, direct: flag(r.direct), dev: flag(r.dev) };
    const id = `external:${info.ecosystem}:${origin}:${name}:${info.direct}:${info.dev}`;
    let el = byId.get(id);
    if (!el) {
      el = { id, kind: 'external', qualifiedName: name, file: NO_FILE, topLevel: true, external: info };
      byId.set(id, el);
    }
    externalRefs.push({ file: r.file_path, line: r.line, sourceSymbol: r.source_symbol, kind: r.kind, target: el });
  }
  return { externals: [...byId.values()], externalRefs };
}
