// Import resolution for languages whose imports name modules, packages or namespaces rather
// than file paths (docs/baton M0-12-R1). Each resolver maps one import target to the indexed file
// it refers to, or null for standard-library and third-party imports. `resolveImports` turns that
// into edge hits: a file plus the module/namespace the edge names (M0-12-R4).
import { posix } from 'node:path';
import { goImportPaths, goModuleByLayout, parseGoMod } from './manifests/go.js';

export interface ImportContext {
  /** Every indexed workspace-relative path. */
  files: Set<string>;
  /** Reads a workspace-relative file that may not be indexed (go.mod); null when absent. */
  readText(path: string): string | null;
  /** True when a workspace-relative path is there, readable or not (a go.mod without permission, M5-23-R1). */
  exists?(path: string): boolean;
  /**
   * Where a local Go `replace` or go.work `use` folder lies, as a workspace-relative path with
   * symlinks resolved, or null when it is outside the workspace and every registered repo. Without
   * it a folder is judged by its path alone (M5-25-R3).
   */
  localDir?(path: string): string | null;
  /** Files declaring a namespace (C#), from the symbol index. */
  namespaceFiles?(namespace: string): string[];
  /** Files declaring a type (class, struct, interface, enum, record) named `name` (C#). */
  typeFiles?(name: string): string[];
  /** Simple names the importing file references (calls, instantiations, base types), for C#'s target choice. */
  referencedNames?: Set<string>;
  /** The namespace a file declares ('' for none), or null when unknown (PHP). */
  fileNamespace?(file: string): string | null;
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
  /** directory → the composer.json PSR-4 roots of it and its ancestors, nearest first. */
  psr4: Map<string, Psr4Root[]>;
}

/** A composer.json `autoload.psr-4` entry: namespace prefix (`App\`) → workspace-relative directory. */
type Psr4Root = { prefix: string; dir: string };

// Built once per file set: the scanner hands every resolver of a scan the same Set.
const indexes = new WeakMap<Set<string>, ImportIndex>();

function indexOf(ctx: ImportContext): ImportIndex {
  let index = indexes.get(ctx.files);
  if (index) return index;
  index = { byBase: new Map(), byLowerBase: new Map(), goByDir: new Map(), psr4: new Map() };
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

/** Every trailing run of folders (`com/acme`, `java/com/acme`, …) of a folder holding JVM sources. */
const jvmPackageSets = new WeakMap<Set<string>, Set<string>>();
function jvmPackagePathsOf(files: Set<string>): Set<string> {
  let paths = jvmPackageSets.get(files);
  if (paths) return paths;
  paths = new Set<string>();
  for (const f of files) {
    if (!/\.(java|kt|kts|scala)$/.test(f)) continue;
    const dirs = dirOf(f).split('/').filter(Boolean);
    for (let i = 0; i < dirs.length; i++) paths.add(dirs.slice(i).join('/'));
  }
  jvmPackageSets.set(files, paths);
  return paths;
}

/**
 * True when a Java import is certainly outside the workspace (M2-08-R5): the class resolves to no
 * indexed file, and its package (`com.vendor` of `com.vendor.Invoice`, of `com.vendor.Util.helper`
 * for a static import) is no folder of JVM sources at any depth. `java.util.List` is outside; an
 * import of a missing class in a project package (`com.acme.Missing` beside `com/acme/`) may be
 * generated or unindexed, so it is not.
 */
export function javaImportOutsideProject(name: string, isStatic: boolean, sourcePath: string, ctx: ImportContext): boolean {
  const parts = name.split('.').filter(Boolean);
  const cls = isStatic ? parts.slice(0, -1) : parts;
  if (cls.length < 2 || resolveJvmImport(name, sourcePath, ctx, ['.java', '.kt'])) return false;
  return !jvmPackagePathsOf(ctx.files).has(cls.slice(0, -1).join('/'));
}

/** A JVM source's text without block and line comments. */
export function stripJvmComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** The `package` a JVM source's text declares, '' for none. */
export function jvmPackageIn(text: string): string {
  return stripJvmComments(text).match(/^[ \t]*package\s+([\w.]+)/m)?.[1] ?? '';
}

/** The single-type and single static imports of Java text, as dotted names; `.*` imports name nothing (M2-08-R5). */
export function javaImportStatements(text: string): Array<{ name: string; isStatic: boolean }> {
  const out: Array<{ name: string; isStatic: boolean }> = [];
  for (const m of stripJvmComments(text).matchAll(/^[ \t]*import\s+(static\s+)?([\w$]+(?:\s*\.\s*[\w$]+)+)\s*;/gm)) {
    out.push({ name: m[2]!.replace(/\s+/g, ''), isStatic: !!m[1] });
  }
  return out;
}

/** What decides whether a project JVM file is a package's declaration: its `package` and the type names it declares (M2-08-R8). */
export function jvmDeclarationSignature(text: string): string {
  const code = stripJvmComments(text);
  const types = new Set<string>();
  for (const m of code.matchAll(/\b(?:class|interface|enum|record|object|trait)\s+([A-Za-z_$][\w$]*)/g)) types.add(m[1]!);
  return `${jvmPackageIn(text)}|${[...types].sort().join(',')}`;
}

/** The qualified names (`a.b.C`) of the types a `jvmDeclarationSignature` declares; none without a package. */
export function jvmSignatureTypes(signature: string): string[] {
  const cut = signature.indexOf('|');
  const pkg = signature.slice(0, Math.max(0, cut));
  return pkg ? signature.slice(cut + 1).split(',').filter(Boolean).map(t => `${pkg}.${t}`) : [];
}

export const JVM_SOURCE = /\.(?:java|kt|kts|scala)$/;

/**
 * What changed files add to or take from the decisions on the imports of others (M2-08-R8):
 * - `stems`: dotted trailing runs of a JVM file's path without extension (the file of a class);
 * - `folders`: dotted trailing runs of a JVM file's folder that no other JVM file has (a package folder
 *   appearing or going), not those of a file added beside others;
 * - `types`: qualified names of the types a JVM file declares, gained or lost;
 * - `pyNames`: folder and module names of a Python file that no other Python file has (a top-level
 *   name `pythonNameInProject` finds appearing or going).
 */
export interface ImportDecisionKeys {
  stems: Set<string>;
  folders: Set<string>;
  types: Set<string>;
  pyNames: Set<string>;
}

export const emptyImportDecisionKeys = (): ImportDecisionKeys => ({ stems: new Set(), folders: new Set(), types: new Set(), pyNames: new Set() });

/** The dotted trailing runs of a JVM file's folder (`a.b.c`, `b.c`, `c`). */
function jvmFolderRuns(path: string): string[] {
  const dirs = dirOf(path).split('/').filter(Boolean);
  return dirs.map((_, i) => dirs.slice(i).join('.'));
}

/** The dotted trailing runs of a JVM file's path without extension (`a.b.C`, `b.C`, `C`). */
function jvmStemRuns(path: string): string[] {
  const dirs = dirOf(path).split('/').filter(Boolean);
  const stem = posix.basename(path).replace(/\.[^.]+$/, '');
  return [...dirs.map((_, i) => [...dirs.slice(i), stem].join('.')), stem];
}

/** The folder and module names a Python file's path gives (`pythonNameInProject`). */
function pythonNamesOf(path: string): string[] {
  const names = dirOf(path).split('/').filter(Boolean);
  const stem = posix.basename(path, '.py');
  if (stem !== '__init__') names.push(stem);
  return names;
}

/**
 * The indexed JVM and Python files left once a change is made, to tell whether a folder or a name a
 * changed file carries is new or lost with it. Built lazily and once: a change that touches no JVM or
 * Python file never reads the paths (M2-08-R8).
 */
export class ImportDecisionBaseline {
  private dirs?: Set<string>;
  private runs?: Set<string>;
  private names?: Set<string>;
  constructor(private readonly paths: () => string[]) {}

  private load(): void {
    if (this.dirs) return;
    this.dirs = new Set();
    this.runs = new Set();
    this.names = new Set();
    for (const p of this.paths()) {
      if (JVM_SOURCE.test(p)) {
        const dir = dirOf(p);
        if (!this.dirs.has(dir)) {
          this.dirs.add(dir);
          for (const r of jvmFolderRuns(p)) this.runs.add(r);
        }
      } else if (p.endsWith('.py')) {
        for (const n of pythonNamesOf(p)) this.names.add(n);
      }
    }
  }

  /** The folder runs of a JVM file that no remaining JVM file has. */
  newFolderRuns(path: string): string[] {
    this.load();
    return this.dirs!.has(dirOf(path)) ? [] : jvmFolderRuns(path).filter(r => !this.runs!.has(r));
  }

  /** The names of a Python file that no remaining Python file has. */
  newPythonNames(path: string): string[] {
    this.load();
    return pythonNamesOf(path).filter(n => !this.names!.has(n));
  }
}

/** Adds what a file at `path` brings or takes; `types` are the qualified type names whose declaration comes or goes. */
export function addImportDecisionKeys(keys: ImportDecisionKeys, path: string, types: string[], baseline: ImportDecisionBaseline): void {
  if (JVM_SOURCE.test(path)) {
    for (const r of jvmStemRuns(path)) keys.stems.add(r);
    for (const r of baseline.newFolderRuns(path)) keys.folders.add(r);
    for (const t of types) keys.types.add(t);
  } else if (path.endsWith('.py')) {
    for (const n of baseline.newPythonNames(path)) keys.pyNames.add(n);
  }
}

/**
 * Whether the decision on a Java import `a.b.C` (or `a.b.C.m`) reads what the keys name: a file at
 * `a/b/C.java`, or the class of a static member (`resolveJvmImport`: `a.b.C` and, one segment up,
 * `a.b.C.m`'s `a.b.C`); the folder of its package (`javaImportOutsideProject`: `a.b`, or `a.b` of a
 * static member's `a.b.C.m`); a file declaring a type `a.b.C`, or the outer class of a nested one
 * (`jvmProjectDeclares`).
 */
export function jvmImportAffected(name: string, keys: ImportDecisionKeys): boolean {
  const parts = name.split('.');
  const head = (drop: number) => (parts.length > drop ? parts.slice(0, parts.length - drop).join('.') : null);
  for (const drop of [0, 1]) { const k = head(drop); if (k && keys.stems.has(k)) return true; }
  for (const drop of [1, 2]) { const k = head(drop); if (k && keys.folders.has(k)) return true; }
  for (let i = 2; i <= parts.length; i++) if (keys.types.has(parts.slice(0, i).join('.'))) return true;
  return false;
}

/** Number of leading directories two paths share. */
function sharedDirs(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/** The candidate in the importing file's own module: most shared leading directories, then shortest (multi-module builds). */
export function closest(hits: string[], sourcePath: string): string {
  let best = hits[0]!;
  for (const h of hits) if (sharedDirs(h, sourcePath) > sharedDirs(best, sourcePath)) best = h;
  return best;
}

/**
 * `closest(hits, ·)` for many source paths: the first hit under each leading directory prefix.
 * The deepest prefix of the source that any hit shares holds the hits with the most shared leading
 * directories, and its first hit is the one `closest` keeps (M4-03).
 */
export function nearestIndex(hits: string[]): (sourcePath: string) => string {
  const first = new Map<string, string>();
  for (const h of hits) {
    const segs = h.split('/');
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix += `${segs[i]}/`;
      if (!first.has(prefix)) first.set(prefix, h);
    }
  }
  return (sourcePath) => {
    const segs = sourcePath.split('/');
    let best = hits[0]!;
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix += `${segs[i]}/`;
      const hit = first.get(prefix);
      if (hit === undefined) break;
      best = hit;
    }
    return best;
  };
}

/** Rust: `crate::a::B`, `self::x`, `super::y` → src/a.rs or src/a/mod.rs (longest module prefix). */
export function resolveRustImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const segs = target.replace(/[{}*].*$/, '').split('::').filter(Boolean);
  if (!segs.length) return null;
  // A crate root's modules live beside it: main.rs, lib.rs, and each src/bin/*.rs (a binary crate of its own).
  const crateRoot = (file: string) => /(^|\/)(main|lib)\.rs$/.test(file) || /(^|\/)src\/bin\/[^/]+\.rs$/.test(file);
  const moduleDir = (file: string) =>
    crateRoot(file) || /(^|\/)mod\.rs$/.test(file) ? dirOf(file) : join(dirOf(file), posix.basename(file, '.rs'));
  let base: string;
  if (segs[0] === 'crate') {
    let dir = dirOf(sourcePath);
    let root: string | null = crateRoot(sourcePath) ? dir : null;
    while (root === null) {
      if (ctx.files.has(join(dir, 'main.rs')) || ctx.files.has(join(dir, 'lib.rs'))) root = dir;
      else if (!dir) break;
      else dir = dirOf(dir);
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

/** A workspace-relative path that climbs out of the workspace (`..`, `../x`). */
const outsideWorkspace = (path: string) => path === '..' || path.startsWith('../');

/** The workspace-relative folder a local replace or `use` names, or null when it is outside the workspace and its repos (M5-25-R3). */
const goLocalDir = (path: string, ctx: ImportContext): string | null => ctx.localDir ? ctx.localDir(path) : outsideWorkspace(path) ? null : path;

// The module path may be quoted: `module "example.com/m"` (or a raw string in backquotes).
const goModulePath = (gomod: string | null | undefined) => gomod?.match(/^module\s+["`]?([^\s"`]+)/m)?.[1];

/**
 * `replace M [v] => ./dir` directives of a go.mod or go.work naming a local directory: [module, dir]
 * (M5-25-R1). In a go.mod, a directive that names a version applies only when go.mod requires
 * that version of M (review of M5-23). A directory outside the workspace (`../../outside/y`) holds
 * no package of it, so its module stays external (M5-25-R3).
 */
function goLocalReplaces(text: string, dir: string, ctx: ImportContext): [string, string][] {
  let requires: ReturnType<typeof parseGoMod>['requires'] | null = null;
  try { requires = parseGoMod(text).requires; } catch { /* a go.work: no requirements */ }
  const out: [string, string][] = [];
  for (const line of text.replace(/\/\/.*$/gm, '').split('\n')) {
    const m = line.match(/^\s*(?:replace\s+)?([^\s()]+)(?:\s+(v\S+))?\s*=>\s*(\.\.?(?:\/\S*)?)\s*$/);
    if (!m || (m[2] && requires && requires.get(m[1]!)?.version !== m[2])) continue;
    const local = goLocalDir(join(dir, m[3]!), ctx);
    if (local !== null) out.push([m[1]!, local]);
  }
  return out;
}

/** The modules of the nearest go.work above `sourcePath` (local replaces, then `use` directories): [module, dir] (M5-25-R1). */
function goWorkModules(sourcePath: string, ctx: ImportContext): [string, string][] {
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const work = ctx.readText(join(dir, 'go.work'));
    if (work !== null) {
      const text = work.replace(/\/\/.*$/gm, '');
      const uses = [...text.matchAll(/^use\s*\(([^)]*)\)/gm)].flatMap((m) => m[1]!.split(/\s+/))
        .concat([...text.matchAll(/^use\s+([^\s(]+)/gm)].map((m) => m[1]!))
        .map((u) => u.replace(/^["`]|["`]$/g, '')).filter(Boolean);
      const modules: [string, string][] = [];
      for (const use of uses) {
        // Nothing outside the workspace and its repos is read.
        const moduleDir = goLocalDir(join(dir, use), ctx);
        if (moduleDir === null) continue;
        // A member whose go.mod cannot be read: its folder layout (review of M5-23-R1).
        const module = goModuleIn(moduleDir, ctx)?.module;
        if (module) modules.push([module, moduleDir]);
      }
      return [...goLocalReplaces(text, dir, ctx), ...modules];
    }
    if (!dir) return [];
  }
}

/** Per file set: a go.mod folder → the module path its folder layout gives (M5-23-R1). */
const goLayoutModules = new WeakMap<Set<string>, Map<string, string | null>>();

/**
 * The module path the folder layout gives a go.mod in `dir` that is there but cannot be read
 * (`goModuleByLayout`; M5-23-R1 and its review). The package folders are the module's own (a folder
 * below with its own go.mod is another module); the imports are those of every non-test Go file of
 * the file set, so a go.work member's packages are voted for by the members that import them, and
 * any third-party prefix a folder matches competes. Null when the layout does not tell. Uncached:
 * the scanner records it as a sync input.
 */
export function goLayoutModule(dir: string, ctx: ImportContext): string | null {
  const present = (p: string) => ctx.readText(p) !== null || !!ctx.exists?.(p);
  const nested = new Map<string, boolean>();
  const inModule = (folder: string): boolean => {
    if (folder === dir) return true;
    let own = nested.get(folder);
    if (own === undefined) nested.set(folder, (own = !present(join(folder, 'go.mod')) && inModule(dirOf(folder))));
    return own;
  };
  const below = (folder: string) => !dir || folder === dir || folder.startsWith(`${dir}/`);
  const packageDirs: string[] = [];
  const imports: string[] = [];
  for (const [folder, files] of indexOf(ctx).goByDir) {
    if (folder !== dir && below(folder) && inModule(folder)) packageDirs.push(dir ? folder.slice(dir.length + 1) : folder);
    for (const f of files) imports.push(...goImportPaths(ctx.readText(f) ?? ''));
  }
  return goModuleByLayout(imports, packageDirs);
}

/**
 * The module path of the go.mod in `dir`: its `module` line, or, when the go.mod is there but cannot
 * be read (a folder, no permission), the path the module's folder layout gives (`goLayoutModule`),
 * so its own packages stay internal (M5-23-R1). Undefined when there is no go.mod, or the layout
 * does not tell.
 */
function goModuleIn(dir: string, ctx: ImportContext): { module: string; gomod: string | null } | undefined {
  const goModPath = join(dir, 'go.mod');
  const gomod = ctx.readText(goModPath);
  if (gomod !== null) {
    const module = goModulePath(gomod);
    return module ? { module, gomod } : undefined;
  }
  if (!ctx.exists?.(goModPath)) return undefined;
  let cache = goLayoutModules.get(ctx.files);
  if (!cache) goLayoutModules.set(ctx.files, (cache = new Map()));
  if (!cache.has(dir)) cache.set(dir, goLayoutModule(dir, ctx));
  const module = cache.get(dir);
  return module ? { module, gomod: null } : undefined;
}

/**
 * Go: module import path → a non-test .go file of that package directory. The module path comes
 * from the go.mod above the importer; a go.mod `replace` with a local directory and the modules of
 * a go.work reach the other modules of a multi-module workspace (M5-25-R1).
 */
export function resolveGoImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const path = target.replace(/^"|"$/g, '');
  // undefined: the import is not in that module.
  const inModule = (module: string, dir: string) => (path === module || path.startsWith(`${module}/`))
    ? indexOf(ctx).goByDir.get(join(dir, path.slice(module.length + 1)))?.[0] ?? null
    : undefined;
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const found = goModuleIn(dir, ctx);
    const module = found?.module;
    // A nested module may import its parent module's packages: keep walking up until a go.mod's
    // module path, or one of its local replaces, prefixes the import.
    if (module) {
      const hit = inModule(module, dir);
      if (hit !== undefined) return hit;
      for (const [replaced, local] of found?.gomod ? goLocalReplaces(found.gomod, dir, ctx) : []) {
        const viaReplace = inModule(replaced, local);
        if (viaReplace !== undefined) return viaReplace;
      }
    }
    if (!dir) break;
  }
  for (const [module, dir] of goWorkModules(sourcePath, ctx)) {
    const hit = inModule(module, dir);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * True when a Go import path is in a module of the workspace (the go.mod above the importer or an
 * ancestor's, their local replaces, the go.work modules), whether or not its package is indexed:
 * `example.com/shop/missing` is the project's own (M5-19).
 */
export function goImportInWorkspaceModule(target: string, sourcePath: string, ctx: ImportContext): boolean {
  const path = target.replace(/^"|"$/g, '');
  const within = (module: string) => path === module || path.startsWith(`${module}/`);
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const found = goModuleIn(dir, ctx);
    if (found && (within(found.module) || (found.gomod !== null && goLocalReplaces(found.gomod, dir, ctx).some(([replaced]) => within(replaced))))) return true;
    if (!dir) break;
  }
  return goWorkModules(sourcePath, ctx).some(([module]) => within(module));
}

/**
 * True when a Go import that resolves to no project package is known to be outside the project: a
 * standard-library path (no dot in its first element, `C` included), or any path once a go.mod or
 * go.work at or above the importer's folder is in the workspace. Otherwise (no go.mod, or the
 * workspace root below it) the import may name the project's own package (M5-25-R1). `exists`
 * counts a go.mod or go.work that is there but cannot be read (review of M5-23).
 */
export function goImportOutsideProject(target: string, sourcePath: string, readText: (path: string) => string | null, exists?: (path: string) => boolean): boolean {
  const path = target.replace(/^"|"$/g, '');
  if (!path.split('/')[0]!.includes('.')) return true;
  const present = (p: string) => readText(p) !== null || !!exists?.(p);
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    if (present(join(dir, 'go.mod')) || present(join(dir, 'go.work'))) return true;
    if (!dir) return false;
  }
}

/**
 * The folders a Python file's absolute imports search, workspace root first: the root, then every
 * ancestor of the file (src/ layouts, sub-projects, a script's own directory). Python 3 has no
 * implicit relative imports, so `import json` inside a package is the stdlib, not pkg/json.py: a
 * package folder (__init__.py) and every folder inside one are no roots (M0-12-R7, M0-12-R9). The
 * workspace root always is, even with a stray __init__.py. A namespace folder outside any package
 * stays a root: run as a script, Python puts its folder on sys.path (D018).
 */
function pythonRoots(sourcePath: string, ctx: ImportContext): string[] {
  const ancestors: string[] = [];
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    ancestors.push(dir);
    if (!dir) break;
  }
  // ancestors run from the file's folder up to the workspace root.
  const topPackage = ancestors.reduce((top, dir, i) => (dir && ctx.files.has(join(dir, '__init__.py')) ? i : top), -1);
  return ancestors.slice(topPackage + 1).reverse();
}

/** Every folder holding a Python file, at any depth: the folders an import can name as a package. */
const pythonFolderSets = new WeakMap<Set<string>, Set<string>>();
function pythonFoldersOf(files: Set<string>): Set<string> {
  let folders = pythonFolderSets.get(files);
  if (folders) return folders;
  folders = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.py')) continue;
    for (let dir = dirOf(f); dir && !folders.has(dir); dir = dirOf(dir)) folders.add(dir);
  }
  pythonFolderSets.set(files, folders);
  return folders;
}

/**
 * True when an absolute Python module that resolves to nothing lies outside the workspace: its
 * top-level name is no module (`x.py`) and no folder holding Python files (a package or namespace
 * package) on any root the import searches. `from app.missing import X` in a workspace with an
 * `app` package is the project's own; a `types/` or `http/` folder of TypeScript files does not hide
 * the standard library's `types` or `http.client` (M5-19 and its review).
 */
export function pythonImportOutsideProject(module: string, sourcePath: string, ctx: ImportContext): boolean {
  if (module.startsWith('.')) return false;
  const top = module.split('.')[0];
  if (!top) return false;
  const folders = pythonFoldersOf(ctx.files);
  return !pythonRoots(sourcePath, ctx).some((root) => ctx.files.has(join(root, `${top}.py`)) || folders.has(join(root, top)));
}

/** The last segments of every Python folder and the stems of every Python module, at any depth. */
const pythonNameSets = new WeakMap<Set<string>, Set<string>>();

/**
 * True when a top-level Python name is a folder holding Python files or a module (`x.py`) anywhere in
 * the workspace, on a searched root or not: `mypkg` of a src/ layout seen from tests/ (review of
 * M2-08-R5). Such an import may be the project's.
 */
export function pythonNameInProject(top: string, ctx: ImportContext): boolean {
  let names = pythonNameSets.get(ctx.files);
  if (!names) {
    names = new Set<string>();
    for (const dir of pythonFoldersOf(ctx.files)) names.add(dir.slice(dir.lastIndexOf('/') + 1));
    for (const f of ctx.files) if (f.endsWith('.py')) names.add(f.slice(f.lastIndexOf('/') + 1, -3));
    pythonNameSets.set(ctx.files, names);
  }
  return names.has(top);
}

/**
 * True when a PHP class or function name that resolves to nothing lies outside the workspace,
 * decided per name: no workspace class, interface, trait, enum or function has that qualified name
 * (`declared`, lower case), and no PSR-4 root of the file's composer.json files covers it. `App\Missing`
 * under `"App\\": "app/"` is the project's own; one workspace file in `namespace Vendor\Other` does
 * not make `Vendor\Lib\Thing` the project's (M5-19 review).
 */
export function phpNameOutsideProject(name: string, sourcePath: string, ctx: ImportContext, declared: Set<string>): boolean {
  const lower = name.replace(/^\\/, '').toLowerCase();
  if (declared.has(lower)) return false;
  return !psr4Roots(dirOf(sourcePath), ctx).some(({ prefix }) => prefix && lower.startsWith(prefix.toLowerCase()));
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
    names = from[2]!.replace(/#.*$/gm, '').replace(/[()\\\n]/g, ' ').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => n && n !== '*');
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
  } else roots = pythonRoots(sourcePath, ctx);
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

/** composer.json PSR-4 roots declared in `dir` and its ancestors, nearest first (autoload, then autoload-dev). */
function psr4Roots(dir: string, ctx: ImportContext): Psr4Root[] {
  const cache = indexOf(ctx).psr4;
  let roots = cache.get(dir);
  if (roots) return roots;
  roots = [];
  let composer: any = null;
  try {
    composer = JSON.parse(ctx.readText(join(dir, 'composer.json')) ?? 'null');
  } catch { /* unreadable composer.json: no roots here */ }
  for (const section of [composer?.autoload, composer?.['autoload-dev']]) {
    const map = section?.['psr-4'];
    if (!map || typeof map !== 'object') continue;
    for (const [prefix, dirs] of Object.entries(map)) {
      for (const d of [dirs].flat()) if (typeof d === 'string') roots.push({ prefix, dir: join(dir, d) });
    }
  }
  if (dir) roots.push(...psr4Roots(dirOf(dir), ctx));
  cache.set(dir, roots);
  return roots;
}

/**
 * PHP: `use App\\Services\\UserService` → the file declaring class UserService in namespace
 * App\\Services (symbol index), else the file composer.json's PSR-4 autoloading maps it to, else
 * …/App/Services/UserService.php (the whole name as a case-insensitive path suffix). Never a
 * shorter suffix: `Illuminate\\Support\\Collection` is not app/Support/Collection.php, and
 * `use Illuminate\\Foundation\\Http\\Kernel as HttpKernel` is not app/Http/Kernel.php (M0-04-R2).
 */
export function resolvePhpImport(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const fqn = target.replace(/^\\/, '');
  const parts = fqn.split('\\').filter(Boolean);
  if (parts.length < 2) return null;
  const other = (f: string) => f !== sourcePath;
  if (ctx.typeFiles && ctx.fileNamespace) {
    const namespace = parts.slice(0, -1).join('\\').toLowerCase();
    const declared = ctx.typeFiles(parts[parts.length - 1]!)
      .filter((f) => other(f) && ctx.fileNamespace!(f)?.toLowerCase() === namespace)
      .sort();
    if (declared.length) return closest(declared, sourcePath);
  }
  const { byLowerBase } = indexOf(ctx);
  const at = (path: string) => {
    const lower = path.toLowerCase();
    return byLowerBase.get(baseOf(lower))?.find((f) => f.toLowerCase() === lower && other(f)) ?? null;
  };
  for (const { prefix, dir } of psr4Roots(dirOf(sourcePath), ctx)) {
    if (!prefix || !fqn.startsWith(prefix)) continue;
    const hit = at(`${join(dir, ...fqn.slice(prefix.length).split('\\'))}.php`);
    if (hit) return hit;
  }
  const suffix = `${parts.join('/')}.php`.toLowerCase();
  const hits = matchSuffix(byLowerBase.get(baseOf(suffix)), suffix, (f) => f.toLowerCase()).filter(other);
  return hits.length ? closest(hits, sourcePath) : null;
}

/**
 * PHP `require` / `include` paths, as the parser emits them: `__DIR__/…` is relative to the
 * including file's folder; a plain relative path is tried there, then at the workspace root (PHP's
 * include path with the entry script at the root). Only an indexed file other than the source
 * resolves (M0-04-R5).
 */
export function resolvePhpInclude(target: string, sourcePath: string, ctx: ImportContext): string | null {
  const dir = dirOf(sourcePath);
  const fromDir = target.startsWith('__DIR__/');
  const rel = fromDir ? target.substring('__DIR__/'.length) : target;
  const candidates = fromDir ? [posix.join(dir, rel)] : [posix.join(dir, rel), posix.normalize(rel)];
  return candidates.find((c) => !c.startsWith('../') && c !== sourcePath && ctx.files.has(c)) ?? null;
}

/** A namespace (`App\Models\User`) never holds `/` or `.php`; an include path does. */
const isPhpIncludePath = (target: string) => target.includes('/') || /\.php$/i.test(target);

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
  php: (t, s, c) => isPhpIncludePath(t)
    ? single(resolvePhpInclude, (path) => path)(t, s, c)
    : single(resolvePhpImport, (name) => name.replace(/^\\/, ''))(t, s, c),
};

/** Resolver for `language` (target file hits, possibly none), or undefined when the language uses path-style imports. */
export function importResolverFor(language: string): Resolver | undefined {
  return LANGUAGE_RESOLVERS[language];
}
