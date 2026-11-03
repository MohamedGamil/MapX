// Composer attribution of external references (M5-21; docs/research/deptrac/02 AR-04 `package` and
// `builtin`, 03 gap G9), on M5-20's design for npm: which Composer package's autoload covers a PHP
// class or function, or which PHP extension defines it as a built-in; whether a composer.json of the
// file lists the package (direct) or only composer.lock holds it (transitive); whether it is dev-only.
// Only composer.json and composer.lock are read, between the file and its repo's root: never vendor/
// or the network. The scanner asks once per folder and name in its end-of-run decision pass.
import type { ExternalAttribution } from '../external-refs.js';
import { repoParentDirs, type NpmWorkspace } from './npm.js';
import { PHP_BUILTINS } from './php-builtins.js';

// ─── Built-ins ──────────────────────────────────────────────────────────────────────────────

/** What a PHP name is: a class (interface, trait, enum), a function or a constant. */
export type PhpKind = 'class' | 'function' | 'const';

let builtins: Record<PhpKind, Map<string, string>> | null = null;

/**
 * The extension, as Composer's platform package (`ext-date`, `ext-pdo`, `ext-core`), that defines a
 * built-in class (interface, trait, enum), function or constant of PHP; null when none does. Classes
 * and functions are case-insensitive, constants case-sensitive, as in PHP; a leading `\` is ignored.
 * The list is static (`php-builtins.ts`), not the running PHP.
 */
export function phpBuiltin(name: string, kind: PhpKind = 'class'): string | null {
  if (!builtins) {
    builtins = { class: new Map(), function: new Map(), const: new Map() };
    for (const [ext, { classes, functions, constants }] of Object.entries(PHP_BUILTINS)) {
      for (const c of classes.split(' ')) if (c) builtins.class.set(c.toLowerCase(), ext);
      for (const f of functions.split(' ')) if (f) builtins.function.set(f.toLowerCase(), ext);
      for (const k of constants.split(' ')) if (k) builtins.const.set(k, ext);
    }
  }
  const bare = name.replace(/^\\/, '');
  return builtins[kind].get(kind === 'const' ? bare : bare.toLowerCase()) ?? null;
}

// ─── Manifests ──────────────────────────────────────────────────────────────────────────────

/** Package names (lowercase) a composer.json requires, for production and in `require-dev`; a name in both is production. */
export interface ComposerRoots { prod: Set<string>; dev: Set<string> }

const objectAt = (o: any, key: string): Record<string, unknown> =>
  o && typeof o === 'object' && o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]) ? o[key] : {};

/**
 * The packages of a requirement list: `vendor/name`. Composer's platform packages (`php`, `ext-pdo`,
 * `lib-icu`, `composer-plugin-api`) have no vendor and load no class: never packages here.
 */
const packageNames = (o: Record<string, unknown>) => Object.keys(o).filter((n) => /^[^/\s]+\/[^/\s]+$/.test(n)).map((n) => n.toLowerCase());

export function composerRoots(manifest: any): ComposerRoots {
  return { prod: new Set(packageNames(objectAt(manifest, 'require'))), dev: new Set(packageNames(objectAt(manifest, 'require-dev'))) };
}

// ─── Lockfile ───────────────────────────────────────────────────────────────────────────────

/** One autoload prefix (PSR-4 `GuzzleHttp\`, PSR-0 `Mustache`), lowercase, and every locked package that registers it. */
interface Prefix { prefix: string; packages: string[] }

/** composer.lock as attribution reads it. */
export interface ComposerLock {
  file: string;
  /** Every locked package (lowercase): dev-only (true, `packages-dev`) or production (false). */
  dev: Map<string, boolean>;
  /** The PSR-4 and PSR-0 prefixes, longest first. */
  prefixes: Prefix[];
  /** Packages that load by `classmap`, `files` or an empty prefix: names no prefix shows. */
  opaque: string[];
  /** Per locked package, the names it stands for: its own, and those it `replace`s or `provide`s. */
  provides: Map<string, Set<string>>;
  /** Every name some locked package stands for. */
  satisfied: Set<string>;
}

/**
 * composer.lock: `packages` (production) and `packages-dev`, each package's `autoload` PSR-4 and
 * PSR-0 prefixes (sibling packages may register one: illuminate/support, collections and macroable
 * all load `Illuminate\Support\`), the packages whose `classmap`, `files` or empty prefix load names
 * the lock does not show, and what each package replaces or provides (laravel/framework replaces
 * illuminate/support). A package in both lists is production. Throws on text that is no Composer lock.
 */
export function parseComposerLock(text: string, file = 'composer.lock'): ComposerLock {
  const lock = JSON.parse(text);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) || !Array.isArray(lock.packages)) throw new Error('not a composer lock');
  const dev = new Map<string, boolean>();
  const byPrefix = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  const provides = new Map<string, Set<string>>();
  const read = (list: unknown, isDev: boolean) => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      const name = typeof p?.name === 'string' ? p.name.toLowerCase() : null;
      if (!name) continue;
      dev.set(name, (dev.get(name) ?? true) && isDev);
      const names = provides.get(name) ?? new Set([name]);
      for (const field of ['replace', 'provide']) for (const n of Object.keys(objectAt(p, field))) names.add(n.toLowerCase());
      provides.set(name, names);
      const autoload = objectAt(p, 'autoload');
      for (const kind of ['psr-4', 'psr-0']) {
        for (const prefix of Object.keys(objectAt(autoload, kind))) {
          if (!prefix) { opaque.add(name); continue; }
          const key = prefix.toLowerCase();
          if (!byPrefix.has(key)) byPrefix.set(key, new Set());
          byPrefix.get(key)!.add(name);
        }
      }
      for (const kind of ['classmap', 'files']) if (Array.isArray((autoload as any)[kind]) && (autoload as any)[kind].length) opaque.add(name);
    }
  };
  read(lock.packages, false);
  read(lock['packages-dev'], true);
  const prefixes = [...byPrefix].map(([prefix, packages]) => ({ prefix, packages: [...packages].sort() }))
    .sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  const satisfied = new Set([...provides.values()].flatMap((s) => [...s]));
  return { file, dev, prefixes, opaque: [...opaque].sort(), provides, satisfied };
}

/**
 * The locked packages whose PSR-4 or PSR-0 prefix covers a name: those of the longest prefix
 * (Composer's lookup; case-insensitive, as PHP names are), more than one when sibling packages share
 * it. A function is matched by its namespace only: a package's `files` define functions in its
 * namespace by convention, and a global function shows no package.
 */
export function lockPackagesOf(lock: ComposerLock, name: string, isFunction: boolean): string[] {
  if (isFunction && !name.includes('\\')) return [];
  const lower = name.replace(/^\\/, '').toLowerCase();
  return lock.prefixes.find((p) => lower.startsWith(p.prefix))?.packages ?? [];
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The package of a namespaced name by Composer naming convention, among candidate packages: the
 * namespace starts with the vendor and holds the package's name (`psr/log` ↔ `Psr\Log\…`,
 * `symfony/console` ↔ `Symfony\Component\Console\…`), or starts with the package's name
 * (`nesbot/carbon` ↔ `Carbon\…`, `phpunit/phpunit` ↔ `PHPUnit\…`). The best match wins; a tie, a
 * global name or no match gives null. Used where no autoload prefix tells: without a lock (the
 * manifests' requirements), for the lock's classmap and files packages, and for required packages a
 * stale lock lacks.
 */
export function packageByConvention(name: string, candidates: Iterable<string>): string | null {
  const segments = name.replace(/^\\/, '').split('\\').slice(0, -1).map(normalize);
  if (!segments.length) return null;
  const scored = [...new Set(candidates)].map((candidate) => {
    const [vendor, pkg] = candidate.split('/').map(normalize);
    const score = !vendor || !pkg ? 0 : segments[0] === vendor && segments.slice(1).includes(pkg) ? 2 : segments[0] === pkg ? 1 : 0;
    return { candidate, score };
  });
  const top = Math.max(0, ...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top);
  return top && best.length === 1 ? best[0]!.candidate : null;
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────

/** What one Composer row names: a class (the default), function or constant, and a facade's target class. */
export interface PhpName { kind?: PhpKind; facadeTarget?: string }

/** What the attributor reads (paths workspace-relative, as `NpmWorkspace`'s). */
export type ComposerWorkspace = Pick<NpmWorkspace, 'readText' | 'repoRootOf'> & {
  /** Whether something is at the path, readable or not (a folder, a file without permission). */
  exists?(path: string): boolean;
};

const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** A package found for a name: by the lock, or by convention among required packages a stale lock lacks (`byManifest`). */
type Found = { package: string; byManifest?: boolean } | { ambiguous: true } | null;

/**
 * Attributes PHP class, function and constant names for one decision pass; composer.json and
 * composer.lock are read once each, only between the file and its repo's root (as `NpmAttributor`).
 * - A PHP built-in (`DateTime`, `PDO`, `str_contains`, `PHP_EOL`) is `builtin`, its package the
 *   extension.
 * - With a readable composer.lock (the nearest folder holding one): the package whose PSR-4/PSR-0
 *   prefix covers the name. Sibling packages that register the same prefix are told apart by the
 *   manifests (the one composer.json requires, for production first, then for dev); else the name is
 *   unknown, never an arbitrary pick (review of M5-21). With no prefix: by naming convention, one of
 *   the lock's classmap or files packages; else one the manifests require and a stale lock lacks
 *   (flagged `manifest`); else none (`package` null): unknown when the lock may still hold it
 *   (`direct` null), not locked when the lock is complete and shows every name its packages load
 *   (`direct` 0).
 * - Without a readable lock (absent, corrupt, a folder, unreadable): by naming convention among the
 *   manifests' requirements, flagged `manifest`; an unmatched name is unknown.
 * - `direct` and `dev` as for npm: a composer.json from the file's folder up to its repo's root
 *   requires the package, or a name it replaces or provides; `dev` from the nearest that lists it
 *   (`require` wins), else from the lock.
 * - A facade (`Illuminate\Support\Facades\DB`) is attributed as the class the file names, as its
 *   `use` row is; its target class decides only when that class shows no package (a global alias).
 */
export class ComposerAttributor {
  /** Every path read, with its text (null: absent or unreadable). */
  readonly reads = new Map<string, string | null>();
  private manifests = new Map<string, ComposerRoots | null>();
  private locks = new Map<string, ComposerLock | null>();
  private lockDirs = new Map<string, boolean>();

  constructor(private readonly workspace: ComposerWorkspace) {}

  private read(path: string): string | null {
    if (!this.reads.has(path)) this.reads.set(path, this.workspace.readText(path));
    return this.reads.get(path)!;
  }

  attribute(name: string, sourcePath: string, what: PhpName = {}): ExternalAttribution {
    const kind = what.kind ?? 'class';
    const builtin = phpBuiltin(name, kind);
    if (builtin) return { package: builtin, origin: 'builtin', direct: null, dev: null, attribution: null };
    const dirs = repoParentDirs(sourcePath, this.workspace.repoRootOf(sourcePath));
    const lock = this.lockFor(dirs);
    const roots = dirs.flatMap((d) => this.manifestAt(d) ?? []);
    const required = new Set(roots.flatMap((r) => [...r.prod, ...r.dev]));
    // Required packages the lock lacks: the lock is stale and cannot show what they load.
    const missing = lock ? [...required].filter((r) => !lock.satisfied.has(r)) : [];
    /** How the manifests list a package (nearest first; `require` wins), by its name or one it replaces or provides. */
    const listing = (pkg: string): { dev: boolean } | null => {
      const names = [...(lock?.provides.get(pkg) ?? [pkg])];
      for (const r of roots) {
        if (names.some((n) => r.prod.has(n))) return { dev: false };
        if (names.some((n) => r.dev.has(n))) return { dev: true };
      }
      return null;
    };
    const find = (n: string, fn: boolean): Found => {
      if (!lock) {
        const pkg = packageByConvention(n, required);
        return pkg ? { package: pkg } : null;
      }
      const candidates = lockPackagesOf(lock, n, fn);
      if (candidates.length === 1) return { package: candidates[0]! };
      if (candidates.length > 1) {
        for (const dev of [false, true]) {
          const listed = candidates.filter((c) => listing(c)?.dev === dev);
          if (listed.length === 1) return { package: listed[0]! };
          if (listed.length > 1) return { ambiguous: true };
        }
        return { ambiguous: true };
      }
      const pkg = packageByConvention(n, lock.opaque);
      if (pkg) return { package: pkg };
      const stale = packageByConvention(n, missing);
      return stale ? { package: stale, byManifest: true } : null;
    };
    // A global constant names no package by its namespace; a namespaced one is matched as a function is.
    let found = kind === 'const' && !name.includes('\\') ? null : find(name, kind !== 'class');
    if (!found && what.facadeTarget) found = find(what.facadeTarget, false);
    if (!found || 'ambiguous' in found) {
      // No single package: unknown, unless a complete lock shows every name its packages load.
      const unlisted = !found && !!lock && !lock.opaque.length && !missing.length;
      const attribution = lock && (found || !missing.length) ? 'lock' : 'manifest';
      return { package: null, origin: 'package', direct: unlisted ? false : null, dev: null, attribution };
    }
    const attribution = lock && !found.byManifest ? 'lock' : 'manifest';
    const listed = listing(found.package);
    if (listed) return { package: found.package, origin: 'package', direct: true, dev: listed.dev, attribution };
    return { package: found.package, origin: 'package', direct: false, dev: lock?.dev.get(found.package) ?? null, attribution };
  }

  private manifestAt(dir: string): ComposerRoots | null {
    if (!this.manifests.has(dir)) {
      let roots: ComposerRoots | null = null;
      try {
        const manifest = JSON.parse(this.read(inDir(dir, 'composer.json')) ?? 'null');
        if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) roots = composerRoots(manifest);
      } catch { /* unreadable: no manifest */ }
      this.manifests.set(dir, roots);
    }
    return this.manifests.get(dir)!;
  }

  /**
   * The nearest folder, from the file up to its repo's root, that holds composer.lock, and that lock
   * if readable. A lock that is there but cannot be read (a folder, no permission) ends the walk as a
   * corrupt one does: the manifests alone answer, never a parent folder's lock (review of M5-21).
   */
  private lockFor(dirs: string[]): ComposerLock | null {
    for (const dir of dirs) {
      const path = inDir(dir, 'composer.lock');
      if (!this.lockDirs.has(dir)) this.lockDirs.set(dir, this.read(path) !== null || !!this.workspace.exists?.(path));
      if (!this.lockDirs.get(dir)) continue;
      if (!this.locks.has(dir)) {
        let lock: ComposerLock | null = null;
        try { lock = parseComposerLock(this.read(path) ?? '', path); } catch { /* unreadable: the manifests alone */ }
        this.locks.set(dir, lock);
      }
      return this.locks.get(dir)!;
    }
    return null;
  }
}
