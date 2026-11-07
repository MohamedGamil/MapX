// npm attribution of external references (M5-20; docs/research/deptrac/02 AR-04 `package` and
// `builtin`, 03 gap G9): which package or Node built-in module an npm specifier names, whether the
// importing file's manifests list the package (direct) or only a lockfile holds it (transitive), and
// whether it is a dev-only dependency. Manifests and lockfiles are read from the workspace, never
// node_modules or the network. The scanner asks once per file and specifier in its end-of-run
// decision pass, so a sync sees the manifests and lockfiles as a forced scan does.
import type { ExternalAttribution } from '../external-refs.js';
import { UNREADABLE_INPUT } from './inputs.js';

/**
 * Node's built-in modules importable without the `node:` prefix: the union of `builtinModules` of
 * Node 20 … 26 (the `_stream_*` modules were dropped in Node 26). Static, so the attribution does not
 * depend on the Node that runs MapX.
 */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap', '_stream_writable',
  '_tls_common', '_tls_wrap',
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
  'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/**
 * Built-ins only the `node:` form names (Node 20 … 26): `test` or `sqlite` without the prefix is an
 * npm package. Any `node:` specifier is a built-in, so this list documents rather than decides.
 */
export const NODE_PREFIX_ONLY_BUILTINS: ReadonlySet<string> = new Set(['test', 'test/reporters', 'sqlite', 'sea', 'ffi', 'quic']);

/**
 * The built-in module a specifier names, as `node:<module>` (`fs`, `node:fs`, `fs/promises` →
 * `node:fs`), or null. Without the prefix only an exact built-in name counts: `fs/x` is no module of
 * Node, and `punycode/` is the npm package.
 */
export function nodeBuiltin(specifier: string): string | null {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : NODE_BUILTINS.has(specifier) ? specifier : null;
  return name ? `node:${name.split('/')[0]}` : null;
}

/** The package an npm specifier names: `@scope/pkg/sub/path` → `@scope/pkg`, `lodash/get` → `lodash`. */
export function npmPackageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

// ─── Lockfiles ──────────────────────────────────────────────────────────────────────────────

/** A lockfile as one graph of package names: whether each is dev-only (true), production (false) or unknown (null). */
export interface NpmLock { file: string; dev: Map<string, boolean | null> }

/** Lockfiles in the order one folder's are tried (npm documents shrinkwrap as taking precedence). */
export const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

const DEP_FIELDS = ['dependencies', 'optionalDependencies'] as const;
const PROD_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Package names a manifest lists for production and in `devDependencies`; a name in both is production (readers check `prod` first). */
export interface ManifestRoots { prod: Set<string>; dev: Set<string> }

/** A manifest's roots. A peer often repeats as a dev dependency: production wins wherever both are read. */
export function manifestRoots(manifest: any): ManifestRoots {
  const prod = new Set<string>();
  for (const f of PROD_FIELDS) for (const n of Object.keys(objectAt(manifest, f))) prod.add(n);
  return { prod, dev: new Set(Object.keys(objectAt(manifest, 'devDependencies'))) };
}

const objectAt = (o: any, key: string): Record<string, unknown> =>
  o && typeof o === 'object' && o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]) ? o[key] : {};

/**
 * Dev-only names of a dependency graph: reachable from development roots and not from production
 * roots; names the roots do not reach stay unknown (null).
 */
function classify(names: Iterable<string>, edges: Map<string, Set<string>>, roots: ManifestRoots[]): Map<string, boolean | null> {
  const reach = (start: Iterable<string>) => {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length) {
      const n = queue.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of edges.get(n) ?? []) queue.push(d);
    }
    return seen;
  };
  const prod = reach(roots.flatMap((r) => [...r.prod]));
  const dev = reach(roots.flatMap((r) => [...r.dev]));
  const out = new Map<string, boolean | null>();
  for (const n of names) out.set(n, prod.has(n) ? false : dev.has(n) ? true : null);
  return out;
}

/**
 * `package-lock.json` / `npm-shrinkwrap.json`: v2/v3 `packages` (keys `node_modules/…`, nested
 * copies included) or the v1 `dependencies` tree, with npm's own `dev` flag. A name is production
 * when any of its copies is (`devOptional` is installed for an optional production dependency).
 * Workspace folders and links are not packages. Throws on text that is no lockfile.
 */
export function parsePackageLock(text: string, file = 'package-lock.json'): NpmLock {
  const lock = JSON.parse(text);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) || !('lockfileVersion' in lock)) throw new Error('not a package lock');
  const dev = new Map<string, boolean | null>();
  const note = (name: string, isDev: boolean) => dev.set(name, (dev.get(name) ?? true) && isDev);
  const packages = objectAt(lock, 'packages');
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf('node_modules/');
    if (at < 0 || (entry as any)?.link) continue;
    note(key.slice(at + 'node_modules/'.length), (entry as any)?.dev === true);
  }
  if (!Object.keys(packages).length) {
    const walk = (deps: Record<string, unknown>) => {
      for (const [name, entry] of Object.entries(deps)) {
        note(name, (entry as any)?.dev === true);
        walk(objectAt(entry, 'dependencies'));
      }
    };
    walk(objectAt(lock, 'dependencies'));
  }
  return { file, dev };
}

/** One YAML-ish line: its indent and its text without quotes around the key. */
const lines = (text: string) => text.split(/\r?\n/).flatMap((raw) => {
  if (!raw.trim() || raw.trimStart().startsWith('#')) return [];
  return [{ indent: raw.length - raw.trimStart().length, text: raw.trim() }];
});

/** The key of a `key: value` or `key:` line, unquoted. */
const keyOf = (text: string): string | null => {
  const m = /^(?:'([^']*)'|"([^"]*)"|([^\s:'"][^:]*?))\s*:(?:\s|$)/.exec(text);
  return m ? (m[1] ?? m[2] ?? m[3]!).trim() : null;
};

/** The value of a `key: value` line, unquoted ('' for none). */
const valueOf = (text: string): string => {
  const m = /^(?:'[^']*'|"[^"]*"|[^\s:'"][^:]*?)\s*:\s*(.*)$/.exec(text);
  return m ? m[1]!.trim().replace(/^['"]|['"]$/g, '') : '';
};

/**
 * The package a pnpm version names when it is an `npm:` alias's target: `real@1.0.0` (v9),
 * `/real@1.0.0` (v6), `/real/1.0.0` (v5); null for a plain version, a link or a file.
 */
function pnpmAliasTarget(version: string): string | null {
  if (!version || /^\d/.test(version) || /^(link|file|workspace|git\+?\w*|https?):/.test(version)) return null;
  return pnpmName(version.startsWith('/') ? version : `/${version}`);
}

/** The package name of a pnpm `packages`/`snapshots` key: v9 `pg@8.0.0(peer@1)`, v6 `/pg@8.0.0`, v5 `/pg/8.0.0_peer@1`. */
function pnpmName(key: string): string | null {
  const v6 = /^\/?((?:@[^/@]+\/)?[^/@(]+)@\d/.exec(key) ?? /^\/?((?:@[^/@]+\/)?[^/@(]+)@[^/]/.exec(key);
  if (v6) return v6[1]!;
  const v5 = /^\/?((?:@[^/]+\/)?[^/]+)\//.exec(key);
  return v5 ? v5[1]! : null;
}

/**
 * `pnpm-lock.yaml` v5, v6 and v9: the importers' dependencies (or the top-level sections of a
 * single-project v5/v6 lock) are the roots, the `packages` and `snapshots` entries' dependencies the
 * edges. Read line by line: only the keys and nesting matter. Throws on text that is no pnpm lock.
 */
export function parsePnpmLock(text: string, file = 'pnpm-lock.yaml'): NpmLock {
  const all = lines(text);
  if (!all.some((l) => l.indent === 0 && /^lockfileVersion\s*:/.test(l.text))) throw new Error('not a pnpm lock');
  const roots: ManifestRoots[] = [];
  const names = new Set<string>();
  const edges = new Map<string, Set<string>>();
  let top = '';
  let importer: ManifestRoots | null = null;
  let section: 'prod' | 'dev' | 'deps' | null = null;
  let sectionIndent = 0;
  let pkg: string | null = null;
  /** The last root entry read, whose nested `version:` line may name an alias's target. */
  let aliased: string | null = null;
  const topRoot: ManifestRoots = { prod: new Set(), dev: new Set() };
  for (const { indent, text: t } of all) {
    const key = keyOf(t);
    if (indent === 0) {
      top = key ?? '';
      importer = null;
      section = null;
      pkg = null;
      if (top === 'dependencies' || top === 'optionalDependencies' || top === 'devDependencies') {
        importer = topRoot;
        section = top === 'devDependencies' ? 'dev' : 'prod';
        sectionIndent = 0;
      }
      continue;
    }
    if (!key) continue;
    if (top === 'importers') {
      if (indent === 2) { importer = { prod: new Set(), dev: new Set() }; roots.push(importer); section = null; continue; }
      if (indent === 4) {
        section = key === 'devDependencies' ? 'dev' : key === 'dependencies' || key === 'optionalDependencies' ? 'prod' : null;
        sectionIndent = 4;
        continue;
      }
    }
    if ((top === 'packages' || top === 'snapshots') && indent === 2) {
      pkg = pnpmName(key);
      if (pkg) names.add(pkg);
      section = null;
      continue;
    }
    if ((top === 'packages' || top === 'snapshots') && indent === 4) {
      section = (DEP_FIELDS as readonly string[]).includes(key) ? 'deps' : null;
      sectionIndent = 4;
      continue;
    }
    // An `npm:` alias (`alias: real@1.0.0`, or a nested `version: real@1.0.0` line) stands for the
    // real package: roots and edges use the names the graph's nodes have.
    if (section && section !== 'deps' && importer && aliased && indent === sectionIndent + 4 && key === 'version') {
      const real = pnpmAliasTarget(valueOf(t));
      if (real) { importer[section].delete(aliased); importer[section].add(real); }
      continue;
    }
    if (!section || indent !== sectionIndent + 2) continue;
    const name = pnpmAliasTarget(valueOf(t)) ?? key;
    if (section === 'deps' && pkg) {
      let set = edges.get(pkg);
      if (!set) edges.set(pkg, (set = new Set()));
      set.add(name);
    } else if (importer && section !== 'deps') {
      importer[section].add(name);
      aliased = name;
    }
  }
  if (topRoot.prod.size || topRoot.dev.size) roots.push(topRoot);
  return { file, dev: classify(names, edges, roots) };
}

/**
 * `yarn.lock`, v1 and Berry: entries (`pg@^8.0.0, pg@^8.1.0:`, `"pg@npm:^8.0.0":`) and their
 * dependencies. Yarn records no dev flag, so the roots are the workspace's manifests. Workspace
 * entries (`@workspace:`) are no packages. Throws on text that is no yarn lock.
 */
export function parseYarnLock(text: string, roots: ManifestRoots[], file = 'yarn.lock'): NpmLock {
  const names = new Set<string>();
  const edges = new Map<string, Set<string>>();
  let pkg: string | null = null;
  let deps = false;
  let entries = 0;
  for (const { indent, text: t } of lines(text)) {
    if (indent === 0) {
      deps = false;
      pkg = null;
      if (!t.endsWith(':') || t === '__metadata:') continue;
      const first = t.slice(0, -1).split(',')[0]!.trim().replace(/^["']|["']$/g, '');
      const at = first.indexOf('@', 1);
      if (at < 0 || first.includes('@workspace:', at)) continue;
      pkg = first.slice(0, at);
      names.add(pkg);
      entries++;
      continue;
    }
    if (!pkg) continue;
    if (indent === 2) { deps = t === 'dependencies:' || t === 'optionalDependencies:'; continue; }
    if (deps && indent === 4) {
      const m = /^"?((?:@[^/"\s:]+\/)?[^"\s:]+)"?(?::|\s)/.exec(t);
      if (!m) continue;
      let set = edges.get(pkg);
      if (!set) edges.set(pkg, (set = new Set()));
      set.add(m[1]!);
    }
  }
  if (!entries && !/^#\s*(yarn lockfile|THIS IS AN AUTOGENERATED FILE)/im.test(text) && !/^__metadata:/m.test(text)) throw new Error('not a yarn lock');
  return { file, dev: classify(names, edges, roots) };
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────

/** What the attributor reads. Paths are workspace-relative: a sibling repo's start with `../`. */
export interface NpmWorkspace {
  /** A workspace file's text; null when it is absent or unreadable. */
  readText(path: string): string | null;
  /** Whether something is at the path, readable or not (a folder, a file without permission). */
  exists?(path: string): boolean;
  /** The root folder of the repo that holds a file: '' for the workspace root, `../R` for a sibling repo. */
  repoRootOf(path: string): string;
  /** The folders holding a package.json, each with its repo's root: walked from indexed files up to their repo's root. */
  manifestDirs(): Iterable<[dir: string, repoRoot: string]>;
}

/** A yarn lock's roots as one pass read them: the repo, the lock's folder and the manifest folders (M5-20 review). */
export interface YarnRoots { repo: string; lock: string; dirs: string[] }

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** Whether a workspace-relative folder is `root` or below it; '' holds no `..` path. */
export const insideDir = (dir: string, root: string) => (root ? dir === root || dir.startsWith(`${root}/`) : !dir.startsWith('..'));

/**
 * The folders from a file's own up to its repo's root, never above it (review of M5-20: a sibling
 * repo's walk went through `..` to the workspace root, another repo's manifests and lockfile).
 */
export function repoParentDirs(path: string, repoRoot: string): string[] {
  const dirs: string[] = [];
  let dir = dirOf(path);
  if (!insideDir(dir, repoRoot)) return [dir];
  for (;;) {
    dirs.push(dir);
    if (dir === repoRoot) return dirs;
    dir = dirOf(dir);
  }
}
const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Attributes npm specifiers for one decision pass: manifests and lockfiles are read once each, only
 * between the file and its repo's root.
 * - A `node:` specifier is a built-in. A bare built-in name (`buffer`, `events`) is a built-in unless
 *   the nearest manifest lists that package: then it is the npm package, a polyfill (review of M5-20).
 * - A package is direct when a package.json from the file's folder up to its repo's root lists it;
 *   `dev` comes from the nearest manifest that lists it, or for a transitive package from the nearest
 *   lockfile. Without a readable lockfile the answer is the manifests' alone, flagged
 *   `attribution: 'manifest'` (a transitive package is then unknown: `dev` null).
 * Every path read is recorded with its text (`reads`), so the scanner can tell when they change.
 */
export class NpmAttributor {
  /** Every path read, with its text (null: absent; `UNREADABLE_INPUT`: there but unreadable). */
  readonly reads = new Map<string, string | null>();
  /** The yarn locks' roots as read. */
  readonly yarnRoots: YarnRoots[] = [];
  private manifests = new Map<string, ManifestRoots | null>();
  private locks = new Map<string, NpmLock | null>();
  private lockDirs = new Map<string, boolean>();

  constructor(private readonly workspace: NpmWorkspace) {}

  /** A path's text, or null when it is absent or unreadable; an unreadable one is recorded as such. */
  private read(path: string): string | null {
    if (!this.reads.has(path)) this.reads.set(path, this.workspace.readText(path) ?? (this.workspace.exists?.(path) ? UNREADABLE_INPUT : null));
    const text = this.reads.get(path)!;
    return text === UNREADABLE_INPUT ? null : text;
  }

  /** Whether something is at the path, readable or not. */
  private present(path: string): boolean {
    return this.read(path) !== null || this.reads.get(path) === UNREADABLE_INPUT;
  }

  attribute(specifier: string, sourcePath: string): ExternalAttribution {
    const repoRoot = this.workspace.repoRootOf(sourcePath);
    const dirs = repoParentDirs(sourcePath, repoRoot);
    const name = npmPackageName(specifier);
    const builtin = nodeBuiltin(specifier);
    if (builtin && (specifier.startsWith('node:') || !this.nearestLists(dirs, name))) {
      return { package: builtin, origin: 'builtin', direct: null, dev: null, attribution: null };
    }
    let listed: { dev: boolean } | null = null;
    for (const dir of dirs) {
      const roots = this.manifestAt(dir);
      if (!roots) continue;
      if (roots.prod.has(name)) { listed = { dev: false }; break; }
      if (roots.dev.has(name)) { listed = { dev: true }; break; }
    }
    const lock = this.lockFor(dirs, repoRoot);
    const attribution = lock ? 'lock' : 'manifest';
    if (listed) return { package: name, origin: 'package', direct: true, dev: listed.dev, attribution };
    return { package: name, origin: 'package', direct: false, dev: lock?.dev.get(name) ?? null, attribution };
  }

  /** Whether the nearest readable manifest lists a package in any dependency field. */
  private nearestLists(dirs: string[], name: string): boolean {
    for (const dir of dirs) {
      const roots = this.manifestAt(dir);
      if (roots) return roots.prod.has(name) || roots.dev.has(name);
    }
    return false;
  }

  private manifestAt(dir: string): ManifestRoots | null {
    if (!this.manifests.has(dir)) {
      let roots: ManifestRoots | null = null;
      try {
        const manifest = JSON.parse(this.read(inDir(dir, 'package.json')) ?? 'null');
        if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) roots = manifestRoots(manifest);
      } catch { /* unreadable: no manifest */ }
      this.manifests.set(dir, roots);
    }
    return this.manifests.get(dir)!;
  }

  /**
   * The nearest folder, from the file up to its repo's root, that holds a lockfile, and its first
   * readable lockfile. A lockfile that is there but cannot be read (a folder, no permission) ends the
   * walk as a corrupt one does: the manifests alone answer, never a parent folder's lockfile (M5-20-R1).
   */
  private lockFor(dirs: string[], repoRoot: string): NpmLock | null {
    for (const dir of dirs) {
      if (!this.lockDirs.has(dir)) this.lockDirs.set(dir, NPM_LOCKFILES.some((f) => this.present(inDir(dir, f))));
      if (!this.lockDirs.get(dir)) continue;
      if (!this.locks.has(dir)) this.locks.set(dir, this.readLock(dir, repoRoot));
      return this.locks.get(dir)!;
    }
    return null;
  }

  private readLock(dir: string, repoRoot: string): NpmLock | null {
    for (const f of NPM_LOCKFILES) {
      const path = inDir(dir, f);
      const text = this.read(path);
      if (text === null) continue;
      try {
        if (f === 'pnpm-lock.yaml') return parsePnpmLock(text, path);
        if (f === 'yarn.lock') return parseYarnLock(text, this.rootsUnder(dir, repoRoot), path);
        return parsePackageLock(text, path);
      } catch { /* unreadable: try the next, else the manifests alone */ }
    }
    return null;
  }

  /** The manifests a yarn lock serves: its repo's package.json files in its folder and below. */
  private rootsUnder(dir: string, repoRoot: string): ManifestRoots[] {
    const dirs = yarnRootDirs(this.workspace.manifestDirs(), dir, repoRoot);
    this.yarnRoots.push({ repo: repoRoot, lock: dir, dirs });
    return dirs.flatMap((d) => this.manifestAt(d) ?? []);
  }
}

/** The manifest folders of one repo in a lock's folder and below, sorted. */
export function yarnRootDirs(manifestDirs: Iterable<[string, string]>, lockDir: string, repoRoot: string): string[] {
  const out = new Set<string>();
  for (const [d, repo] of manifestDirs) if (repo === repoRoot && insideDir(d, lockDir)) out.add(d);
  return [...out].sort();
}
