// Composer attribution of external references (M5-21; docs/research/deptrac/02 AR-04 `package` and
// `builtin`, 03 gap G9), on M5-20's design for npm: which Composer package's autoload covers a PHP
// class or function, or which PHP extension defines it as a built-in; whether a composer.json of the
// file lists the package (direct) or only composer.lock holds it (transitive); whether it is dev-only.
// Only composer.json and composer.lock are read, between the file and its repo's root, and, when
// present, Composer's generated metadata under vendor/composer (M5-21-R1): never a package's sources
// or the network. The scanner asks once per folder and name in its end-of-run decision pass.
import { posix } from 'node:path';
import type { ExternalAttribution } from '../external-refs.js';
import { repoParentDirs, type NpmWorkspace } from './npm.js';
import { PHP_BUILTINS } from './php-builtins.js';
import { PHP_PECL } from './php-pecl.js';
import { COMPOSER_VENDOR_INPUTS, UNREADABLE_INPUT } from './inputs.js';

// ─── Built-ins ──────────────────────────────────────────────────────────────────────────────

/** What a PHP name is: a class (interface, trait, enum), a function or a constant. */
export type PhpKind = 'class' | 'function' | 'const';

type NameIndex = Record<PhpKind, Map<string, string>>;

function indexNames(list: Record<string, { classes: string; functions: string; constants: string }>): NameIndex {
  const index: NameIndex = { class: new Map(), function: new Map(), const: new Map() };
  for (const [ext, { classes, functions, constants }] of Object.entries(list)) {
    for (const c of classes.split(' ')) if (c) index.class.set(c.toLowerCase(), ext);
    for (const f of functions.split(' ')) if (f) index.function.set(f.toLowerCase(), ext);
    for (const k of constants.split(' ')) if (k) index.const.set(k, ext);
  }
  return index;
}

const lookup = (index: NameIndex, name: string, kind: PhpKind) => {
  const bare = name.replace(/^\\/, '');
  return index[kind].get(kind === 'const' ? bare : bare.toLowerCase()) ?? null;
};

let builtins: NameIndex | null = null;
let pecl: NameIndex | null = null;

/**
 * The extension, as Composer's platform package (`ext-date`, `ext-pdo`, `ext-core`), that defines a
 * built-in class (interface, trait, enum), function or constant of PHP; null when none does. Classes
 * and functions are case-insensitive, constants case-sensitive, as in PHP; a leading `\` is ignored.
 * The list is static (`php-builtins.ts`), not the running PHP.
 */
export function phpBuiltin(name: string, kind: PhpKind = 'class'): string | null {
  return lookup((builtins ??= indexNames(PHP_BUILTINS)), name, kind);
}

/**
 * The PECL extension (`ext-redis`, `ext-imagick`, `ext-apcu`) that defines a class, function or
 * constant, or null (M5-21-R1). Decision: such a name is `ambient`, not `builtin`. PHP itself does
 * not ship it, and no Composer package provides it (composer.json can only require it as a platform
 * package): the runtime it is deployed on does, as the C symbols of cgo's `C`. The list is static
 * (`php-pecl.ts`, the PECL extensions of the PHP the generator reflected).
 */
export function phpPecl(name: string, kind: PhpKind = 'class'): string | null {
  return lookup((pecl ??= indexNames(PHP_PECL)), name, kind);
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

// ─── vendor/composer (M5-21-R1) ─────────────────────────────────────────────────────────────

/** One entry of a generated autoload map: its key (a class, or a `files` identifier) and its file, relative to the Composer root. */
export interface AutoloadEntry { key: string; path: string }

/** The largest vendor/composer file read (review of M5-21-R1): a bigger one is skipped, with a warning. */
export const COMPOSER_VENDOR_MAX_BYTES = 64 * 1024 * 1024;

/** A path Composer wrote that no relative path reaches: POSIX-absolute, a drive (`C:/`) or a UNC share. */
const absolutePath = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p);

/**
 * The tokens of a generated PHP array, in one pass over the text (review of M5-21-R1: linear, never
 * a backtracking regex): single- and double-quoted strings (as their value), `=>`, `.`, `,`, the
 * variables and the `__DIR__` constant Composer's generator writes; everything else is skipped.
 */
function phpArrayTokens(text: string): Array<{ kind: 'string' | 'arrow' | 'dot' | 'comma' | 'name'; value: string }> {
  const out: Array<{ kind: 'string' | 'arrow' | 'dot' | 'comma' | 'name'; value: string }> = [];
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      let value = '';
      let j = i + 1;
      for (; j < n && text[j] !== c; j++) {
        if (text[j] === '\\' && j + 1 < n) {
          const next = text[j + 1]!;
          // Single quotes escape only `\\` and `\'`; double quotes also `\"` and `\$` (enough for paths).
          if (next === '\\' || next === c || (c === '"' && next === '$')) { value += next; j++; continue; }
        }
        value += text[j];
      }
      out.push({ kind: 'string', value });
      i = j + 1;
    } else if (c === '=' && text[i + 1] === '>') { out.push({ kind: 'arrow', value: '=>' }); i += 2; }
    else if (c === '.') { out.push({ kind: 'dot', value: '.' }); i++; }
    else if (c === ',') { out.push({ kind: 'comma', value: ',' }); i++; }
    else if (c === '$' || c === '_' || /[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /\w/.test(text[j]!)) j++;
      out.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
    } else if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; }
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; }
    else i++;
  }
  return out;
}

/**
 * The entries of `vendor/composer/autoload_classmap.php` or `autoload_files.php` as Composer
 * generates them (`'Class\\Name' => $vendorDir . '/pkg/name/src/X.php'`), read as text, never
 * executed, by a linear tokenizer. A path is relative to the Composer root: `$vendorDir` is
 * `vendor/`, `$baseDir` the root and `__DIR__` `vendor/composer/`; a plain absolute path (a package
 * outside the project) is kept as written and maps to no package. Throws on text that is no autoload map.
 */
export function parseAutoloadMap(text: string): AutoloadEntry[] {
  const tokens = phpArrayTokens(text);
  if (!tokens.some((t) => t.kind === 'name' && t.value === 'return')) throw new Error('not a Composer autoload map');
  const bases: Record<string, string> = { $vendorDir: 'vendor/', $baseDir: '', __DIR__: 'vendor/composer/' };
  const out: AutoloadEntry[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [key, arrow, value] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!];
    if (key.kind !== 'string' || arrow.kind !== 'arrow') continue;
    let path: string | null = null;
    if (value.kind === 'string' && absolutePath(value.value)) path = value.value;
    else if (value.kind === 'name' && value.value in bases && tokens[i + 3]?.kind === 'dot' && tokens[i + 4]?.kind === 'string') {
      // `$vendorDir . '/a' . '/b'` (autoload_static's form) joins every literal that follows.
      let rest = '';
      let k = i + 4;
      for (; tokens[k]?.kind === 'string'; k += 2) {
        rest += tokens[k]!.value;
        if (tokens[k + 1]?.kind !== 'dot') break;
      }
      path = posix.normalize(`${bases[value.value]}${rest.replace(/^\/+/, '')}`);
    }
    if (path !== null) out.push({ key: key.value, path });
  }
  return out;
}

/** vendor/composer/installed.json as attribution reads it. */
export interface ComposerInstalled {
  /** Each installed package (lowercase) and its install path, relative to the Composer root; null for a metapackage. */
  packages: Array<{ name: string; path: string | null }>;
  /** `dev-package-names` (Composer 2), or null when the file does not say. */
  dev: Set<string> | null;
}

/**
 * installed.json: Composer 2's `{"packages": [...], "dev-package-names": [...]}`, whose
 * `install-path` is relative to vendor/composer/, or Composer 1's list of packages, each at
 * vendor/<name>. Throws on text that is no installed.json.
 */
export function parseInstalledJson(text: string): ComposerInstalled {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.packages) ? data.packages : null;
  if (!list) throw new Error('not a Composer installed.json');
  const packages = list.filter((p: any) => typeof p?.name === 'string').map((p: any) => {
    const name = (p.name as string).toLowerCase();
    const at = 'install-path' in p ? p['install-path'] : `../${name}`;
    // An absolute install path (a package outside the project, review of M5-21-R1) holds no root-relative file.
    return { name, path: typeof at === 'string' && !absolutePath(at) ? posix.normalize(posix.join('vendor/composer', at)).replace(/\/+$/, '') : null };
  });
  const dev = Array.isArray(data?.['dev-package-names']) ? new Set<string>(data['dev-package-names'].filter((n: unknown) => typeof n === 'string').map((n: string) => n.toLowerCase())) : null;
  return { packages, dev };
}

/**
 * What one Composer root's vendor/composer tells, each file read and parsed on first need and
 * cached for the pass: a large classmap is parsed once, and its paths mapped to packages per lookup.
 * A file absent, unreadable or not in Composer's format tells nothing.
 */
class ComposerVendor {
  private classmap?: Map<string, string> | null;
  private files?: string[] | null;
  private installed?: ComposerInstalled | null;
  private owners = new Map<string, string | null>();

  constructor(private readonly root: string, private readonly read: (path: string) => string | null) {}

  private parse<T>(file: string, parser: (text: string) => T): T | null {
    const text = this.read(inDir(this.root, file));
    if (text === null) return null;
    try { return parser(text); } catch { return null; }
  }

  /** installed.json, when readable. */
  installedJson(): ComposerInstalled | null {
    if (this.installed === undefined) this.installed = this.parse(COMPOSER_VENDOR_INPUTS.installed, parseInstalledJson);
    return this.installed;
  }

  /**
   * The package installed at a root-relative path: the longest install path of installed.json that
   * holds it; without a readable installed.json, `vendor/<vendor>/<name>/…`, Composer's default.
   */
  private ownerOf(path: string): string | null {
    let owner = this.owners.get(path);
    if (owner !== undefined) return owner;
    const installed = this.installedJson();
    owner = null;
    if (installed) {
      let best = -1;
      for (const p of installed.packages) {
        if (p.path !== null && p.path.length > best && path.startsWith(`${p.path}/`)) { owner = p.name; best = p.path.length; }
      }
    } else {
      owner = /^vendor\/([^/]+\/[^/]+)\/./.exec(path)?.[1]?.toLowerCase() ?? null;
    }
    this.owners.set(path, owner);
    return owner;
  }

  /** The package whose file the classmap names for a class (case-insensitive), or null. */
  classPackage(name: string): string | null {
    if (this.classmap === undefined) {
      const entries = this.parse(COMPOSER_VENDOR_INPUTS.classmap, parseAutoloadMap);
      this.classmap = entries && new Map(entries.map((e) => [e.key.toLowerCase(), e.path]));
    }
    const path = this.classmap?.get(name.replace(/^\\/, '').toLowerCase());
    return path === undefined ? null : this.ownerOf(path);
  }

  /** The packages whose `files` autoload loads a file, sorted; null when autoload_files.php tells nothing. */
  filesPackages(): string[] | null {
    if (this.files === undefined) {
      const entries = this.parse(COMPOSER_VENDOR_INPUTS.files, parseAutoloadMap);
      this.files = entries && [...new Set(entries.map((e) => this.ownerOf(e.path)).filter((p): p is string => p !== null))].sort();
    }
    return this.files;
  }

  /** Whether installed.json lists the package as dev-only; null when it does not tell. */
  devOf(pkg: string): boolean | null {
    const installed = this.installedJson();
    return installed?.dev && installed.packages.some((p) => p.name === pkg) ? installed.dev.has(pkg) : null;
  }
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────

/** What one Composer row names: a class (the default), function or constant, and a facade's target class. */
export interface PhpName { kind?: PhpKind; facadeTarget?: string }

/** What the attributor reads (paths workspace-relative, as `NpmWorkspace`'s). */
export type ComposerWorkspace = Pick<NpmWorkspace, 'readText' | 'repoRootOf' | 'exists'> & {
  /** A file's size in bytes, null when absent: vendor/composer files over the cap are not read (review of M5-21-R1). */
  size?(path: string): number | null;
  /** Where a skipped file is reported (console.warn by default). */
  warn?(message: string): void;
};

/** What a vendor/composer file skipped for its size is recorded as, with its size (an input that changes with it). */
const TOO_LARGE_INPUT = '\u0000too-large:';

const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * A package found for a name: by the lock, by convention among required packages a stale lock lacks
 * (`byManifest`), or by vendor/composer's metadata (`installed`, M5-21-R1).
 */
type Found = { package: string; byManifest?: boolean; installed?: boolean } | { ambiguous: true } | null;

/**
 * Attributes PHP class, function and constant names for one decision pass; composer.json and
 * composer.lock are read once each, only between the file and its repo's root (as `NpmAttributor`).
 * - A PHP built-in (`DateTime`, `PDO`, `str_contains`, `PHP_EOL`) is `builtin`, its package the
 *   extension; a PECL extension's name (`Redis`, `apcu_fetch`) is `ambient` (M5-21-R1).
 * - When the Composer root (the nearest folder with a composer.lock, else a composer.json) has
 *   vendor/composer metadata (M5-21-R1): a class the classmap names is the package installed where
 *   its file is (installed.json's install paths), before any prefix, so an optimised autoloader also
 *   tells sibling packages of one prefix apart; a function no prefix covers is the package whose
 *   `files` autoload loads, when only one does (a namespaced one: by convention among them).
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
 *   (`require` wins), else from the lock, else from installed.json's `dev-package-names`. A package
 *   found by the vendor metadata is flagged `lock` when composer.lock or installed.json was read.
 * - A facade (`Illuminate\Support\Facades\DB`) is attributed as the class the file names, as its
 *   `use` row is; its target class decides only when that class shows no package (a global alias).
 */
export class ComposerAttributor {
  /** Every path read, with its text (null: absent; `UNREADABLE_INPUT`: there but unreadable). */
  readonly reads = new Map<string, string | null>();
  private manifests = new Map<string, ComposerRoots | null>();
  private locks = new Map<string, ComposerLock | null>();
  private lockDirs = new Map<string, boolean>();
  private vendors = new Map<string, ComposerVendor>();

  constructor(private readonly workspace: ComposerWorkspace) {}

  /** A path's text, or null when it is absent or unreadable; an unreadable one is recorded as such. */
  private read(path: string): string | null {
    if (!this.reads.has(path)) this.reads.set(path, this.workspace.readText(path) ?? (this.workspace.exists?.(path) ? UNREADABLE_INPUT : null));
    const text = this.reads.get(path)!;
    return text === UNREADABLE_INPUT ? null : text;
  }

  /**
   * A vendor/composer file's text, or null when it is absent, unreadable or larger than
   * `COMPOSER_VENDOR_MAX_BYTES` (skipped with one warning, recorded so a change is noticed).
   */
  private readCapped(path: string): string | null {
    const size = this.workspace.size?.(path) ?? null;
    if (size !== null && size > COMPOSER_VENDOR_MAX_BYTES) {
      if (!this.reads.has(path)) {
        this.reads.set(path, `${TOO_LARGE_INPUT}${size}`);
        (this.workspace.warn ?? console.warn)(`[mapx] Skipped ${path} (${size} bytes, over ${COMPOSER_VENDOR_MAX_BYTES}): its Composer classmap or files autoload is not read for attribution.`);
      }
      return null;
    }
    return this.read(path);
  }

  /** Whether something is at the path, readable or not. */
  private present(path: string): boolean {
    return this.read(path) !== null || this.reads.get(path) === UNREADABLE_INPUT;
  }

  attribute(name: string, sourcePath: string, what: PhpName = {}): ExternalAttribution {
    const kind = what.kind ?? 'class';
    const builtin = phpBuiltin(name, kind);
    if (builtin) return { package: builtin, origin: 'builtin', direct: null, dev: null, attribution: null };
    const extension = phpPecl(name, kind);
    if (extension) return { package: extension, origin: 'ambient', direct: null, dev: null, attribution: null };
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
    const vendor = this.vendorFor(dirs);
    const find = (n: string, fn: boolean): Found => {
      // The classmap names the file of a class (every class, once the autoloader is optimised).
      if (!fn) {
        const pkg = vendor?.classPackage(n);
        if (pkg) return { package: pkg, installed: true };
      }
      // A namespaced function no prefix covers, by naming convention among the packages whose `files`
      // autoload loads. Never a global function: MapX reads no package source, so nothing shows which
      // file defines it, even when only one package loads files (review of M5-21-R1).
      const viaFiles = (): Found => {
        const files = fn && n.includes('\\') ? vendor?.filesPackages() : null;
        const pkg = files?.length ? packageByConvention(n, files) : null;
        return pkg ? { package: pkg, installed: true } : null;
      };
      if (!lock) {
        const installed = viaFiles();
        if (installed) return installed;
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
      const installed = viaFiles();
      if (installed) return installed;
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
    const attribution = (found.installed ? lock || vendor?.installedJson() : lock && !found.byManifest) ? 'lock' : 'manifest';
    const listed = listing(found.package);
    if (listed) return { package: found.package, origin: 'package', direct: true, dev: listed.dev, attribution };
    return { package: found.package, origin: 'package', direct: false, dev: lock?.dev.get(found.package) ?? vendor?.devOf(found.package) ?? null, attribution };
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
   * The vendor/composer metadata of the Composer root: the nearest folder, from the file up to its
   * repo's root, holding a composer.lock (readable or not), else the nearest holding vendor/composer
   * metadata; null for none. A nested composer.json (a path package of a monorepo) is no root: the
   * project's lock and vendor/ are above it (review of M5-21-R1).
   */
  private vendorFor(dirs: string[]): ComposerVendor | null {
    const root = dirs.find((d) => this.present(inDir(d, 'composer.lock')))
      ?? dirs.find((d) => Object.values(COMPOSER_VENDOR_INPUTS).some((f) => this.present(inDir(d, f))));
    if (root === undefined) return null;
    let vendor = this.vendors.get(root);
    if (!vendor) this.vendors.set(root, (vendor = new ComposerVendor(root, (path) => this.readCapped(path))));
    return vendor;
  }

  /**
   * The nearest folder, from the file up to its repo's root, that holds composer.lock, and that lock
   * if readable. A lock that is there but cannot be read (a folder, no permission) ends the walk as a
   * corrupt one does: the manifests alone answer, never a parent folder's lock (review of M5-21).
   */
  private lockFor(dirs: string[]): ComposerLock | null {
    for (const dir of dirs) {
      const path = inDir(dir, 'composer.lock');
      if (!this.lockDirs.has(dir)) this.lockDirs.set(dir, this.present(path));
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
