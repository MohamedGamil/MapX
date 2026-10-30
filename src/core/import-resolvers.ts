// Import resolution for languages whose imports name modules, packages or namespaces rather
// than file paths (docs/baton M0-12-R1). Each resolver maps one import target to the indexed file
// it refers to, or null for standard-library and third-party imports.
import { posix } from 'node:path';

export interface ImportContext {
  /** Every indexed workspace-relative path. */
  files: Set<string>;
  /** Reads a workspace-relative file that may not be indexed (go.mod); null when absent. */
  readText(path: string): string | null;
  /** Files declaring a namespace (C#), from the symbol index. */
  namespaceFiles?(namespace: string): string[];
}

const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p));
const join = (...parts: string[]) => posix.join(...parts.filter(Boolean));
const first = (ctx: ImportContext, candidates: string[]) => candidates.find((c) => ctx.files.has(c)) ?? null;

/** Indexed files whose path ends with `suffix` (as whole path segments), shortest first. */
function bySuffix(ctx: ImportContext, suffix: string): string[] {
  const hits: string[] = [];
  for (const f of ctx.files) if (f === suffix || f.endsWith(`/${suffix}`)) hits.push(f);
  return hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Java, Kotlin, Scala: `com.ex.lib.Bar` → …/com/ex/lib/Bar.<ext>; a static member or nested class falls back one segment. */
export function resolveJvmImport(target: string, sourcePath: string, ctx: ImportContext, exts: string[]): string | null {
  const parts = target.replace(/^import\s+/, '').replace(/\s+as\s+\w+$/, '').replace(/\.(\*|_)$/, '').split('.').filter(Boolean);
  if (parts.length < 2 || target.endsWith('*')) return null;
  for (let n = parts.length; n >= Math.max(2, parts.length - 1); n--) {
    const base = parts.slice(0, n).join('/');
    for (const ext of exts) {
      const hits = bySuffix(ctx, `${base}${ext}`);
      if (hits.length) return hits.find((h) => h.split('/')[0] === sourcePath.split('/')[0]) ?? hits[0]!;
    }
  }
  return null;
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
  } else return null; // std::, external crates
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
    if (module) {
      if (path !== module && !path.startsWith(`${module}/`)) return null;
      const pkgDir = join(dir, path.slice(module.length + 1));
      const files = [...ctx.files].filter((f) => dirOf(f) === pkgDir && f.endsWith('.go') && !f.endsWith('_test.go')).sort();
      return files[0] ?? null;
    }
    if (!dir) return null;
  }
}

/** Python: `import a.b`, `from .x import y`, `from pkg import mod` → module file or package __init__.py. */
export function resolvePythonImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
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
  for (const root of roots) {
    // from pkg import mod → pkg/mod.py when mod is a submodule, else the module itself.
    for (const name of names) {
      const sub = first(ctx, moduleCandidates(root, [...dotted, name]));
      if (sub) return sub;
    }
    const hit = first(ctx, moduleCandidates(root, dotted));
    if (hit) return hit;
  }
  return null;
}

/** Ruby: require_relative / require → relative to the file, then common load paths. */
export function resolveRubyImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const rel = target.replace(/\.rb$/, '');
  const roots = [dirOf(sourcePath), '', 'lib', 'app', 'src'];
  for (const root of roots) {
    const hit = first(ctx, [`${join(root, rel)}.rb`]);
    if (hit) return hit;
  }
  return null;
}

/** C#: `using Lib.Models;` → a file declaring that namespace. */
export function resolveCSharpImport(target: string, _sourcePath: string, ctx: ImportContext): string | null {
  const files = ctx.namespaceFiles?.(target.trim()) ?? [];
  return files.sort()[0] ?? null;
}

/** PHP: `use App\\Services\\UserService` → the PSR-4 file …/Services/UserService.php (case-insensitive first segment). */
export function resolvePhpImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const parts = target.replace(/^\\/, '').split('\\').filter(Boolean);
  if (parts.length < 2) return null;
  const lower = new Map<string, string>();
  for (const f of ctx.files) if (f.endsWith('.php')) lower.set(f.toLowerCase(), f);
  // Longest suffix first: App/Services/UserService.php, then Services/UserService.php.
  for (let start = 0; start <= parts.length - 2; start++) {
    const suffix = `${parts.slice(start).join('/')}.php`.toLowerCase();
    const hits = [...lower.entries()].filter(([l]) => l === suffix || l.endsWith(`/${suffix}`)).map(([, f]) => f).sort((a, b) => a.length - b.length);
    if (hits.length) return hits.find((h) => h.split('/')[0] === sourcePath.split('/')[0]) ?? hits[0]!;
  }
  return null;
}

const LANGUAGE_RESOLVERS: Record<string, (t: string, s: string, c: ImportContext) => string | null> = {
  java: (t, s, c) => resolveJvmImport(t, s, c, ['.java', '.kt']),
  kotlin: (t, s, c) => resolveJvmImport(t, s, c, ['.kt', '.java']),
  scala: (t, s, c) => resolveJvmImport(t, s, c, ['.scala', '.java']),
  rust: resolveRustImport,
  go: resolveGoImport,
  python: resolvePythonImport,
  ruby: resolveRubyImport,
  'c-sharp': resolveCSharpImport,
  php: resolvePhpImport,
};

/** Resolver for `language`, or undefined when the language uses path-style imports. */
export function importResolverFor(language: string) {
  return LANGUAGE_RESOLVERS[language];
}
