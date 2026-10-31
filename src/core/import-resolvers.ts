// Import resolution for languages whose imports name modules, packages or namespaces rather
// than file paths (docs/baton M0-12-R1). Each resolver maps one import target to the indexed file
// it refers to, or null for standard-library and third-party imports. `resolveImports` turns that
// into edge hits: a file plus the module/namespace the edge names (M0-12-R4).
import { posix } from 'node:path';

export interface ImportContext {
  /** Every indexed workspace-relative path. */
  files: Set<string>;
  /** Reads a workspace-relative file that may not be indexed (go.mod); null when absent. */
  readText(path: string): string | null;
  /** Files declaring a namespace (C#), from the symbol index. */
  namespaceFiles?(namespace: string): string[];
  /** Files declaring a type (class, struct, interface, enum, record) named `name` (C#). */
  typeFiles?(name: string): string[];
  /** Simple names the importing file references (calls, instantiations, base types), for C#'s target choice. */
  referencedNames?: Set<string>;
}

/** One import edge: the target file and the module, package or namespace it names. */
export interface ImportHit {
  file: string;
  symbol: string;
}

const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p));
const join = (...parts: string[]) => posix.join(...parts.filter(Boolean));
const first = (ctx: ImportContext, candidates: string[]) => candidates.find((c) => ctx.files.has(c)) ?? null;
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Lookup tables over one file set, so each import costs a bucket lookup rather than a scan of every file (M0-12-R3). */
interface ImportIndex {
  /** basename → files with that basename. */
  byBase: Map<string, string[]>;
  /** lower-case basename → files (PHP namespaces are matched case-insensitively). */
  byLowerBase: Map<string, string[]>;
  /** directory → its non-test .go files, sorted. */
  goByDir: Map<string, string[]>;
}

// Built once per file set: the scanner hands every resolver of a scan the same Set.
const indexes = new WeakMap<Set<string>, ImportIndex>();

function indexOf(ctx: ImportContext): ImportIndex {
  let index = indexes.get(ctx.files);
  if (index) return index;
  index = { byBase: new Map(), byLowerBase: new Map(), goByDir: new Map() };
  const push = (m: Map<string, string[]>, k: string, f: string) => {
    const list = m.get(k);
    if (list) list.push(f);
    else m.set(k, [f]);
  };
  for (const f of ctx.files) {
    const base = baseOf(f);
    push(index.byBase, base, f);
    push(index.byLowerBase, base.toLowerCase(), f);
    if (f.endsWith('.go') && !f.endsWith('_test.go')) push(index.goByDir, dirOf(f), f);
  }
  for (const list of index.goByDir.values()) list.sort();
  indexes.set(ctx.files, index);
  return index;
}

/** Files of `bucket` whose path ends with `suffix` as whole path segments, shortest first. */
function matchSuffix(bucket: string[] | undefined, suffix: string, path: (f: string) => string = (f) => f): string[] {
  if (!bucket) return [];
  const hits = bucket.filter((f) => {
    const p = path(f);
    return p === suffix || p.endsWith(`/${suffix}`);
  });
  return hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Indexed files whose path ends with `suffix` (as whole path segments), shortest first. */
function bySuffix(ctx: ImportContext, suffix: string): string[] {
  return matchSuffix(indexOf(ctx).byBase.get(baseOf(suffix)), suffix);
}

/** Java, Kotlin, Scala: `com.ex.lib.Bar` → …/com/ex/lib/Bar.<ext>; a static member or nested class falls back one segment. */
export function resolveJvmImport(target: string, sourcePath: string, ctx: ImportContext, exts: string[]): string | null {
  const parts = target.replace(/^import\s+/, '').replace(/\s+as\s+\w+$/, '').replace(/\.(\*|_)$/, '').split('.').filter(Boolean);
  if (parts.length < 2 || target.endsWith('*')) return null;
  for (let n = parts.length; n >= Math.max(2, parts.length - 1); n--) {
    const base = parts.slice(0, n).join('/');
    for (const ext of exts) {
      const hits = bySuffix(ctx, `${base}${ext}`);
      if (hits.length) return closest(hits, sourcePath);
    }
  }
  return null;
}

/** Number of leading directories two paths share. */
function sharedDirs(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/** The candidate in the importing file's own module: most shared leading directories, then shortest (multi-module builds). */
function closest(hits: string[], sourcePath: string): string {
  let best = hits[0]!;
  for (const h of hits) if (sharedDirs(h, sourcePath) > sharedDirs(best, sourcePath)) best = h;
  return best;
}

/** Rust: `crate::a::B`, `self::x`, `super::y` → src/a.rs or src/a/mod.rs (longest module prefix). */
export function resolveRustImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const segs = target.replace(/[{}*].*$/, '').split('::').filter(Boolean);
  if (!segs.length) return null;
  const moduleDir = (file: string) =>
    /(^|\/)(main|lib|mod)\.rs$/.test(file) ? dirOf(file) : join(dirOf(file), posix.basename(file, '.rs'));
  let base: string;
  if (segs[0] === 'crate') {
    let dir = dirOf(sourcePath);
    let root: string | null = null;
    for (;;) {
      if (ctx.files.has(join(dir, 'main.rs')) || ctx.files.has(join(dir, 'lib.rs'))) root = dir;
      if (!dir) break;
      dir = dirOf(dir);
      if (root !== null) break;
    }
    if (root === null) return null;
    base = root;
    segs.shift();
  } else if (segs[0] === 'self') {
    base = moduleDir(sourcePath);
    segs.shift();
  } else if (segs[0] === 'super') {
    base = moduleDir(sourcePath);
    while (segs[0] === 'super') {
      base = dirOf(base);
      segs.shift();
    }
  } else {
    // Uniform paths (2018+): `use foo::Bar` and `mod foo;` name a child of the current module;
    // anything else (std::, external crates) has no file and so no edge.
    base = moduleDir(sourcePath);
  }
  for (let n = segs.length; n >= 1; n--) {
    const path = join(base, ...segs.slice(0, n));
    const hit = first(ctx, [`${path}.rs`, join(path, 'mod.rs')]);
    if (hit) return hit;
  }
  return null;
}

/** Go: module import path → a non-test .go file of that package directory (go.mod gives the module path). */
export function resolveGoImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const path = target.replace(/^"|"$/g, '');
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const gomod = ctx.readText(join(dir, 'go.mod'));
    const module = gomod?.match(/^module\s+(\S+)/m)?.[1];
    // A nested module may import its parent module's packages: keep walking up until a go.mod's
    // module path prefixes the import.
    if (module && (path === module || path.startsWith(`${module}/`))) {
      const pkgDir = join(dir, path.slice(module.length + 1));
      return indexOf(ctx).goByDir.get(pkgDir)?.[0] ?? null;
    }
    if (!dir) return null;
  }
}

/** Python: `import a.b`, `from .x import y`, `from pkg import mod` → module file or package __init__.py. */
export function resolvePythonImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  return resolvePythonImports(target, sourcePath, ctx)[0]?.file ?? null;
}

/**
 * Python, one hit per distinct target file: `from pkg import a, b` links pkg/a.py and pkg/b.py when
 * they are submodules, else the package itself; the symbol is the dotted module (`pkg.a`, `.sib`).
 */
export function resolvePythonImports(target: string, sourcePath: string, ctx: ImportContext): ImportHit[] {
  let module: string;
  let names: string[] = [];
  const from = target.match(/^from\s+(\.*[\w.]*)\s+import\s+(.+)$/s);
  if (from) {
    module = from[1]!;
    names = from[2]!.replace(/[()\\\n]/g, ' ').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => n && n !== '*');
  } else module = target.replace(/^import\s+/, '').split(/\s+as\s+/)[0]!.trim();
  const dots = module.match(/^\.*/)![0].length;
  const dotted = module.slice(dots).split('.').filter(Boolean);
  const moduleCandidates = (base: string, parts: string[]) => {
    const p = join(base, ...parts);
    return parts.length ? [`${p}.py`, join(p, '__init__.py')] : [join(base, '__init__.py')];
  };
  let roots: string[];
  if (dots) {
    let base = dirOf(sourcePath);
    for (let i = 1; i < dots; i++) base = dirOf(base);
    roots = [base];
  } else {
    // Absolute imports: workspace root, then every ancestor of the file (src/ layouts, sub-projects).
    roots = [];
    for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
      roots.push(dir);
      if (!dir) break;
    }
    roots.reverse();
  }
  const qualified = (name: string) => (module.endsWith('.') ? `${module}${name}` : `${module}.${name}`);
  const hits: ImportHit[] = [];
  const add = (file: string | null, symbol: string) => {
    if (file && !hits.some((h) => h.file === file)) hits.push({ file, symbol });
    return !!file;
  };
  // from pkg import mod → pkg/mod.py when mod is a submodule, else the module itself (per name).
  for (const name of names.length ? names : [null]) {
    for (const root of roots) {
      if (name !== null && add(first(ctx, moduleCandidates(root, [...dotted, name])), qualified(name))) break;
      if (add(first(ctx, moduleCandidates(root, dotted)), module)) break;
    }
  }
  return hits;
}

/** Directories Ruby projects put on the load path ($LOAD_PATH): gems' lib/, RSpec's spec/, minitest's test/. */
const RUBY_LOAD_DIRS = new Set(['lib', 'spec', 'test']);

/**
 * Ruby. `./x` / `../x` (the parser marks `require_relative 'x'` as `./x`) resolve only against the
 * file's directory. A plain `require 'x'` searches load paths: lib/ under each enclosing directory,
 * and an enclosing directory that is itself a load path (spec/ for spec_helper). It never searches
 * the file's own directory otherwise, so lib/a/json.rb does not capture `require 'json'`.
 */
export function resolveRubyImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const rel = target.replace(/\.rb$/, '');
  if (/^\.\.?\//.test(rel)) return first(ctx, [`${join(dirOf(sourcePath), rel)}.rb`]);
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const candidates = [`${join(dir, 'lib', rel)}.rb`];
    if (RUBY_LOAD_DIRS.has(posix.basename(dir))) candidates.unshift(`${join(dir, rel)}.rb`);
    const hit = first(ctx, candidates);
    if (hit) return hit;
    if (!dir) return null;
  }
}

/** C# `using` target without the `global::` alias. */
const csharpName = (target: string) => target.trim().replace(/^global::/, '');

/** C#: `using Lib.Models;` → a file declaring that namespace (first, when several do). */
export function resolveCSharpImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  return resolveCSharpImports(target, sourcePath, ctx)[0] ?? null;
}

/**
 * C#. `using Ns` (or an alias `using A = Ns`) → the files declaring Ns whose types the importing
 * file uses, else the first declaring file. A name that is no namespace is a type (`using static
 * Ns.Type`, `using H = Ns.Type`) → the file declaring Type in Ns; C# forbids a namespace and a type
 * with the same full name, so the two cannot be confused.
 */
export function resolveCSharpImports(target: string, _sourcePath: string, ctx: ImportContext): string[] {
  const name = csharpName(target);
  const typeIn = (qualified: string) => {
    const dot = qualified.lastIndexOf('.');
    if (dot < 0) return [];
    const inNamespace = new Set(ctx.namespaceFiles?.(qualified.slice(0, dot)) ?? []);
    return (ctx.typeFiles?.(qualified.slice(dot + 1)) ?? []).filter((f) => inNamespace.has(f)).sort();
  };
  const files = [...new Set(ctx.namespaceFiles?.(name) ?? [])].sort();
  if (!files.length) return typeIn(name);
  if (files.length === 1) return files;
  const used = new Set<string>();
  for (const ref of ctx.referencedNames ?? []) for (const f of ctx.typeFiles?.(ref) ?? []) used.add(f);
  const chosen = files.filter((f) => used.has(f));
  return chosen.length ? chosen : [files[0]!];
}

/** PHP: `use App\\Services\\UserService` → the PSR-4 file …/Services/UserService.php (case-insensitive first segment). */
export function resolvePhpImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const parts = target.replace(/^\\/, '').split('\\').filter(Boolean);
  if (parts.length < 2) return null;
  const { byLowerBase } = indexOf(ctx);
  // Longest suffix first: App/Services/UserService.php, then Services/UserService.php.
  for (let start = 0; start <= parts.length - 2; start++) {
    const suffix = `${parts.slice(start).join('/')}.php`.toLowerCase();
    const hits = matchSuffix(byLowerBase.get(baseOf(suffix)), suffix, (f) => f.toLowerCase());
    if (hits.length) return hits.find((h) => h.split('/')[0] === sourcePath.split('/')[0]) ?? hits[0]!;
  }
  return null;
}

type Resolver = (target: string, sourcePath: string, ctx: ImportContext) => ImportHit[];

/** One hit when `file` resolved, named `symbol`. */
const single = (resolve: (t: string, s: string, c: ImportContext) => string | null, symbol: (t: string) => string): Resolver =>
  (t, s, c) => {
    const file = resolve(t, s, c);
    return file ? [{ file, symbol: symbol(t) }] : [];
  };

const jvmName = (t: string) => t.replace(/^import\s+/, '').replace(/\s+as\s+\w+$/, '').trim();
const rustName = (t: string) => t.replace(/\s+as\s+\w+$/, '').replace(/::\{[\s\S]*$/, '').trim();

const LANGUAGE_RESOLVERS: Record<string, Resolver> = {
  java: single((t, s, c) => resolveJvmImport(t, s, c, ['.java', '.kt']), jvmName),
  kotlin: single((t, s, c) => resolveJvmImport(t, s, c, ['.kt', '.java']), jvmName),
  scala: single((t, s, c) => resolveJvmImport(t, s, c, ['.scala', '.java']), jvmName),
  rust: single(resolveRustImport, rustName),
  go: single(resolveGoImport, (t) => t.replace(/^"|"$/g, '')),
  python: resolvePythonImports,
  // The `./` marker on require_relative targets is the parser's, not the source's.
  ruby: single(resolveRubyImport, (t) => t.replace(/^\.\/(?!\.)/, '')),
  'c-sharp': (t, s, c) => resolveCSharpImports(t, s, c).map((file) => ({ file, symbol: csharpName(t) })),
  php: single(resolvePhpImport, (t) => t.replace(/^\\/, '')),
};

/** Resolver for `language` (target file hits, possibly none), or undefined when the language uses path-style imports. */
export function importResolverFor(language: string): Resolver | undefined {
  return LANGUAGE_RESOLVERS[language];
}
