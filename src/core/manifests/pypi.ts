// pip, Poetry and uv attribution of external references (M5-22; docs/research/deptrac/02 AR-04
// `package` and `builtin`, 03 gap G9), on M5-20's design for npm and M5-21's for Composer: which
// distribution provides an imported Python module, or whether the standard library does; whether a
// manifest of the file (pyproject.toml, requirements files) lists it (direct) or only a lockfile
// (uv.lock, poetry.lock) holds it (transitive); whether it is dev-only. Only those files are read,
// between the file and its repo's root: never site-packages, a venv or the network. The scanner asks
// once per folder and module in its end-of-run decision pass.
import { posix } from 'node:path';
import type { ExternalAttribution } from '../external-refs.js';
import { insideDir, repoParentDirs, type NpmWorkspace } from './npm.js';
import { matchGlob, UNREADABLE_INPUT } from './inputs.js';
import { PYTHON_STDLIB_MODULES } from './python-stdlib.js';
import { parseToml } from './toml.js';

// ─── Standard library and names ─────────────────────────────────────────────────────────────

/** The top-level modules of the standard library of Python 3.10 … 3.15 (`python-stdlib.ts`, generated). */
export const PYTHON_STDLIB: ReadonlySet<string> = new Set(PYTHON_STDLIB_MODULES.split(' '));

/**
 * The standard-library module an import names, as `python:<top-level module>` (`os.path` →
 * `python:os`), or null. The standard library comes before site-packages on `sys.path`, so a
 * distribution of the same name never shadows it. The list is static, not the running Python's.
 */
export function pythonBuiltin(module: string): string | null {
  const top = module.split('.')[0]!;
  return PYTHON_STDLIB.has(top) ? `python:${top}` : null;
}

/** A distribution name normalised per PEP 503: lowercase, runs of `-`, `_` and `.` as one `-`. */
export const normalizeDist = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Well-known import names that are not their distribution's name (normalised), keyed by the import
 * name as Python spells it (case-sensitive) or a dotted prefix. An entry lists every well-known
 * distribution that provides the module, so a name two distributions provide (`cv2`, `psycopg2`,
 * `jwt`) stays ambiguous unless the inputs tell. Without site-packages MapX cannot read
 * `top_level.txt`; anything else is matched by the import name's own normalised form only.
 */
export const IMPORT_DISTRIBUTIONS: Readonly<Record<string, readonly string[]>> = {
  attr: ['attrs'],
  Bio: ['biopython'],
  bs4: ['beautifulsoup4'],
  Crypto: ['pycryptodome', 'pycrypto'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'],
  dateutil: ['python-dateutil'],
  dns: ['dnspython'],
  docx: ['python-docx'],
  dotenv: ['python-dotenv'],
  fitz: ['pymupdf'],
  gi: ['pygobject'],
  git: ['gitpython'],
  github: ['pygithub'],
  'google.protobuf': ['protobuf'],
  grpc: ['grpcio'],
  jose: ['python-jose'],
  jwt: ['pyjwt', 'jwt'],
  kafka: ['kafka-python'],
  ldap: ['python-ldap'],
  Levenshtein: ['levenshtein', 'python-levenshtein'],
  magic: ['python-magic'],
  multipart: ['python-multipart', 'multipart'],
  MySQLdb: ['mysqlclient'],
  nacl: ['pynacl'],
  OpenSSL: ['pyopenssl'],
  PIL: ['pillow'],
  pkg_resources: ['setuptools'],
  pptx: ['python-pptx'],
  psycopg2: ['psycopg2', 'psycopg2-binary'],
  serial: ['pyserial'],
  skimage: ['scikit-image'],
  sklearn: ['scikit-learn'],
  slugify: ['python-slugify', 'awesome-slugify'],
  socks: ['pysocks'],
  telegram: ['python-telegram-bot'],
  usb: ['pyusb'],
  websocket: ['websocket-client'],
  win32api: ['pywin32'],
  win32con: ['pywin32'],
  yaml: ['pyyaml'],
  zmq: ['pyzmq'],
};

/** A requirement: its distribution (normalised) and the extras it asks for. */
export interface PyRequirement { name: string; extras: string[] }

/** A PEP 508 requirement's name and extras (`Flask[async]>=2; python_version>"3.8"` → flask, async); null when it names none. */
export function parseRequirement(spec: string): PyRequirement | null {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?/.exec(spec);
  if (!m) return null;
  // After the name and extras PEP 508 allows only a version, a marker or `@ url`: anything else
  // (`git+https://…`, `https://…`, `C:\…`, `local/dir`) is a URL or path, not a name (review of M5-22).
  const rest = spec.slice(m[0].length).trimStart();
  if (rest && !/^[<>=!~;@(,]/.test(rest)) return null;
  return { name: normalizeDist(m[1]!), extras: (m[2] ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) };
}

// ─── Manifests ──────────────────────────────────────────────────────────────────────────────

/**
 * Distributions a folder's manifests list, for production and dev, with their extras; a name in both
 * is production (readers check `prod` first). `broken`: a manifest is there but cannot be read, so
 * what it lists is unknown (review of M5-22). `poetry`: the pyproject has a `[tool.poetry]` table.
 */
export interface PyRoots { prod: Map<string, string[]>; dev: Map<string, string[]>; broken?: boolean; poetry?: boolean }

/** Extras (`[project.optional-dependencies]`) that are development tooling: dev, not production. */
export const DEV_EXTRAS: ReadonlySet<string> = new Set(['dev', 'devel', 'develop', 'development', 'test', 'tests', 'testing', 'lint', 'linting', 'doc', 'docs', 'typing', 'types', 'mypy']);

const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tableAt = (o: unknown, ...keys: string[]): Record<string, unknown> => {
  let t: unknown = o;
  for (const k of keys) t = isTable(t) ? t[k] : undefined;
  return isTable(t) ? t : {};
};
const listAt = (o: unknown, key: string): unknown[] => (isTable(o) && Array.isArray(o[key]) ? o[key] as unknown[] : []);

const add = (into: Map<string, string[]>, r: PyRequirement | null) => {
  if (r) into.set(r.name, [...new Set([...(into.get(r.name) ?? []), ...r.extras])]);
};

/** A Poetry dependency table's entries: `name = "^1"`, `{ version, extras }` or a list of those. */
function poetryDeps(into: Map<string, string[]>, deps: Record<string, unknown>, skipOptional = false) {
  for (const [name, spec] of Object.entries(deps)) {
    if (name.toLowerCase() === 'python') continue;
    const specs = Array.isArray(spec) ? spec : [spec];
    if (skipOptional && specs.every((s) => isTable(s) && s.optional === true)) continue;
    const extras = specs.flatMap((s) => (isTable(s) && Array.isArray(s.extras) ? s.extras.filter((e): e is string => typeof e === 'string') : []));
    add(into, { name: normalizeDist(name), extras: extras.map((e) => e.toLowerCase()) });
  }
}

/**
 * A pyproject.toml's roots. Production: PEP 621 `[project] dependencies` and the extras of
 * `[project.optional-dependencies]` (an extra is installed for production use), except extras named
 * for development tooling (`test`, `tests`, `dev`, `lint`, `docs`, `typing`, … `DEV_EXTRAS`), which are
 * dev; Poetry's `[tool.poetry.dependencies]` (not `python`) and group `main`. Dev: PEP 735
 * `[dependency-groups]`, Poetry's `[tool.poetry.dev-dependencies]` and other groups, uv's legacy
 * `[tool.uv] dev-dependencies`.
 */
export function pyprojectRoots(doc: unknown): PyRoots {
  const prod = new Map<string, string[]>();
  const dev = new Map<string, string[]>();
  const strings = (into: Map<string, string[]>, list: unknown[]) => {
    for (const s of list) if (typeof s === 'string') add(into, parseRequirement(s));
  };
  const project = tableAt(doc, 'project');
  strings(prod, listAt(project, 'dependencies'));
  for (const [extra, list] of Object.entries(tableAt(project, 'optional-dependencies'))) if (Array.isArray(list)) strings(DEV_EXTRAS.has(extra.toLowerCase()) ? dev : prod, list);
  // `{ include-group = "test" }` entries include a group that is read on its own.
  for (const list of Object.values(tableAt(doc, 'dependency-groups'))) if (Array.isArray(list)) strings(dev, list);
  const poetry = tableAt(doc, 'tool', 'poetry');
  poetryDeps(prod, tableAt(poetry, 'dependencies'));
  poetryDeps(dev, tableAt(poetry, 'dev-dependencies'));
  for (const [group, body] of Object.entries(tableAt(poetry, 'group'))) poetryDeps(group === 'main' ? prod : dev, tableAt(body, 'dependencies'));
  strings(dev, listAt(tableAt(doc, 'tool', 'uv'), 'dev-dependencies'));
  return { prod, dev, poetry: isTable(tableAt(doc, 'tool').poetry) };
}

/** Requirement files a folder's manifests include: `requirements.txt`, `requirements-dev.txt`, `dev-requirements.txt`, … */
export const REQUIREMENTS_GLOB = '*requirements*.txt';

/** Qualifiers of a requirements file that make it dev-only (`requirements-dev.txt`, `test-requirements.txt`, `requirements_docs.txt`). */
const DEV_QUALIFIERS = new Set(['dev', 'devel', 'develop', 'development', 'test', 'tests', 'testing', 'lint', 'linting', 'doc', 'docs',
  'typing', 'types', 'mypy', 'check', 'checks', 'ci', 'bench', 'benchmark', 'qa', 'style', 'format', 'tox']);

/** Whether a requirements file is dev-only, by its name: a qualifier around `requirements` names development. */
export function requirementsFileIsDev(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase().replace(/\.txt$/, '');
  return base.split('requirements').join('-').split(/[-_.\s]+/).some((q) => DEV_QUALIFIERS.has(q));
}

/**
 * A requirements file's requirements and the files it includes (`-r`/`--requirement`). Options,
 * paths, URLs and constraints files (`-c`) name no distribution; `-e …#egg=name` and `name @ url` do.
 */
export function parseRequirementsTxt(text: string): { requirements: PyRequirement[]; includes: string[] } {
  const requirements: PyRequirement[] = [];
  const includes: string[] = [];
  for (const raw of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const include = /^(?:-r|--requirement)(?:\s*=\s*|\s+|(?=\S))(\S+)/.exec(line);
    if (include) { includes.push(include[1]!); continue; }
    const editable = /^(?:-e|--editable)(?:\s*=\s*|\s+)(\S+)/.exec(line);
    if (editable) {
      const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(editable[1]!);
      if (egg) requirements.push({ name: normalizeDist(egg[1]!), extras: [] });
      continue;
    }
    if (line.startsWith('-') || line.startsWith('.') || /\.(whl|zip|tar\.gz|tgz)$/i.test(line.split(/\s/)[0]!)) continue;
    // A VCS or URL line (`git+https://…#egg=name`) names its distribution by `#egg=` only.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(line)) {
      const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (egg) requirements.push({ name: normalizeDist(egg[1]!), extras: [] });
      continue;
    }
    const r = parseRequirement(line);
    if (r) requirements.push(r);
  }
  return { requirements, includes };
}

// ─── Lockfiles ──────────────────────────────────────────────────────────────────────────────

/** A lockfile as attribution reads it: every locked distribution (normalised), dev-only (true), production (false) or unknown (null). */
export interface PyLock { file: string; dev: Map<string, boolean | null> }

/** Lockfiles in the order one folder's are tried. */
export const PY_LOCKFILES = ['uv.lock', 'poetry.lock'] as const;

/** One locked distribution's dependencies, and those each of its extras adds. */
interface Node { deps: PyRequirement[]; extras: Map<string, PyRequirement[]> }

/**
 * Dev-only names of a lock's graph: reachable from development roots and not from production
 * roots, following the extras each edge asks for; names no root reaches stay unknown (null).
 */
function classify(nodes: Map<string, Node>, prodRoots: PyRequirement[], devRoots: PyRequirement[]): Map<string, boolean | null> {
  const reach = (roots: PyRequirement[]) => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const r = queue.pop()!;
      const node = nodes.get(r.name);
      if (!seen.has(r.name)) {
        seen.add(r.name);
        queue.push(...(node?.deps ?? []));
      }
      for (const extra of r.extras) {
        if (seen.has(`${r.name}[${extra}]`)) continue;
        seen.add(`${r.name}[${extra}]`);
        queue.push(...(node?.extras.get(extra) ?? []));
      }
    }
    return seen;
  };
  const prod = reach(prodRoots);
  const dev = reach(devRoots);
  const out = new Map<string, boolean | null>();
  for (const n of nodes.keys()) out.set(n, prod.has(n) ? false : dev.has(n) ? true : null);
  return out;
}

/** uv's `{ name = "x", extra = ["y"] }` entries. */
const uvEntries = (list: unknown): PyRequirement[] => (Array.isArray(list) ? list : []).flatMap((e) =>
  isTable(e) && typeof e.name === 'string'
    ? [{ name: normalizeDist(e.name), extras: Array.isArray(e.extra) ? e.extra.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [] }]
    : []);

/**
 * `uv.lock`: every `[[package]]`; the workspace members (`source` editable or virtual) are the roots,
 * their dependencies and extras production (development extras, `DEV_EXTRAS`, dev), their
 * dependency groups (`dev-dependencies`) dev.
 * Throws on text that is no uv lock.
 */
export function parseUvLock(text: string, file = 'uv.lock'): PyLock {
  const doc = parseToml(text);
  if (typeof doc.version !== 'number' || (doc.package !== undefined && !Array.isArray(doc.package))) throw new Error('not a uv lock');
  const nodes = new Map<string, Node>();
  const prodRoots: PyRequirement[] = [];
  const devRoots: PyRequirement[] = [];
  for (const p of (doc.package as unknown[] | undefined) ?? []) {
    if (!isTable(p) || typeof p.name !== 'string') continue;
    const name = normalizeDist(p.name);
    const extras = new Map(Object.entries(tableAt(p, 'optional-dependencies')).map(([x, list]) => [x.toLowerCase(), uvEntries(list)]));
    nodes.set(name, { deps: uvEntries(p.dependencies), extras });
    const source = tableAt(p, 'source');
    if ('editable' in source || 'virtual' in source) {
      prodRoots.push(...uvEntries(p.dependencies));
      for (const [extra, list] of extras) (DEV_EXTRAS.has(extra) ? devRoots : prodRoots).push(...list);
      for (const list of Object.values(tableAt(p, 'dev-dependencies'))) devRoots.push(...uvEntries(list));
    }
  }
  return { file, dev: classify(nodes, prodRoots, devRoots) };
}

/**
 * `poetry.lock`: every `[[package]]`; dev-only from its `groups` (lock 2.1: not in `main`), else its
 * `category` (lock 1.x: `dev`), else by reachability from the roots (the lock folder's pyproject),
 * along `[package.dependencies]` (optional ones only through an extra asked for) and
 * `[package.extras]`. Throws on text that is no Poetry lock.
 */
export function parsePoetryLock(text: string, roots: PyRoots[], file = 'poetry.lock'): PyLock {
  const doc = parseToml(text);
  if (!isTable(doc.metadata) || (doc.package !== undefined && !Array.isArray(doc.package))) throw new Error('not a poetry lock');
  const nodes = new Map<string, Node>();
  const flags = new Map<string, boolean>();
  for (const p of (doc.package as unknown[] | undefined) ?? []) {
    if (!isTable(p) || typeof p.name !== 'string') continue;
    const name = normalizeDist(p.name);
    const deps = new Map<string, string[]>();
    poetryDeps(deps, tableAt(p, 'dependencies'), true);
    const extras = new Map(Object.entries(tableAt(p, 'extras')).map(([x, list]) =>
      [x.toLowerCase(), (Array.isArray(list) ? list : []).flatMap((s) => (typeof s === 'string' ? [parseRequirement(s)].filter((r): r is PyRequirement => !!r) : []))]));
    nodes.set(name, { deps: [...deps].map(([n, e]) => ({ name: n, extras: e })), extras });
    if (Array.isArray(p.groups)) flags.set(name, (flags.get(name) ?? true) && !p.groups.includes('main'));
    else if (typeof p.category === 'string') flags.set(name, (flags.get(name) ?? true) && p.category === 'dev');
  }
  if (flags.size) return { file, dev: new Map([...nodes.keys()].map((n) => [n, flags.get(n) ?? null])) };
  const entries = (m: Map<string, string[]>) => [...m].map(([name, extras]) => ({ name, extras }));
  return { file, dev: classify(nodes, roots.flatMap((r) => entries(r.prod)), roots.flatMap((r) => entries(r.dev))) };
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────

/** What the attributor reads (paths workspace-relative, as `NpmWorkspace`'s). */
export type PypiWorkspace = Pick<NpmWorkspace, 'readText' | 'repoRootOf' | 'exists'> & {
  /** The names in a folder, or null when it cannot be listed. */
  listDir?(dir: string): string[] | null;
};

const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);


/**
 * Distributions that provide a standard-library module some Python versions removed (`cgi` →
 * legacy-cgi, `audioop` → audioop-lts, `distutils` → setuptools from 3.12); any `standard-<module>`
 * backport counts too. When a manifest lists one, the module is that package, not the built-in.
 */
export const STDLIB_BACKPORTS: Readonly<Record<string, readonly string[]>> = {
  asynchat: ['pyasynchat'],
  asyncore: ['pyasyncore'],
  audioop: ['audioop-lts'],
  cgi: ['legacy-cgi'],
  cgitb: ['legacy-cgi'],
  distutils: ['setuptools'],
  imp: ['zombie-imp'],
  smtpd: ['pysmtpd'],
};

/**
 * Attributes Python modules for one decision pass; manifests and lockfiles are read once each, only
 * between the file and its repo's root (as `NpmAttributor`).
 * - A standard-library module (`os`, `os.path`, `tomllib`) is `builtin`, its package `python:<module>`,
 *   unless a manifest lists a backport of it (`legacy-cgi` for `cgi`): then that package.
 * - The distribution: for each prefix of the module, longest first, the candidates are the
 *   well-known distributions of that import name (`IMPORT_DISTRIBUTIONS`) and the name's own
 *   normalised form; a candidate counts when a manifest or the lockfile names it. Only when no prefix
 *   of the module counts is the imported name tried as a submodule (`from google.cloud import
 *   storage`), so `from flask import json` stays flask. Several that count are told apart by the
 *   manifests (production first, then dev), else the module is unknown, never an arbitrary pick
 *   (review of M5-21). When none counts, a well-known import name with one distribution is that
 *   distribution, in no manifest (`direct` 0, `dev` null), unless a complete lockfile lacks it: then,
 *   as for any other module, unknown (`package` null): an import name is not a distribution name.
 * - `direct` and `dev` as for npm: a manifest from the file's folder up to its repo's root lists the
 *   distribution; `dev` from the nearest that lists it (production wins), else from the lockfile.
 * - The lockfile is the nearest folder's `uv.lock` or `poetry.lock` (poetry.lock first when the
 *   folder's pyproject has `[tool.poetry]`). One that is there but cannot be read ends the walk: the
 *   manifests alone answer, flagged `manifest` (M5-20-R1, review of M5-21), as does a required
 *   distribution a stale lockfile lacks.
 * - A manifest that is there but cannot be read (review of M5-22): what it lists is unknown, so no
 *   answer is `direct` 0 or backed by the lock alone: `direct` null for a package no readable manifest
 *   lists, and everything flagged `manifest`.
 */
export class PypiAttributor {
  /**
   * Every path read, with its text (null: absent; `UNREADABLE_INPUT`: there but unreadable); a
   * folder's requirement files under `dir/*requirements*.txt` and `dir/requirements/*.txt`.
   */
  readonly reads = new Map<string, string | null>();
  private manifests = new Map<string, PyRoots | null>();
  private locks = new Map<string, PyLock | null>();
  private lockDirs = new Map<string, boolean>();

  constructor(private readonly workspace: PypiWorkspace) {}

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

  /**
   * `symbol` is the name used from the module (`storage` of `from google.cloud import storage`, or
   * `storage.Client` of a call through it): it may be a submodule, tried when the module itself
   * names no distribution.
   */
  attribute(module: string, sourcePath: string, symbol: string | null = null): ExternalAttribution {
    const repoRoot = this.workspace.repoRootOf(sourcePath);
    const dirs = repoParentDirs(sourcePath, repoRoot);
    const roots = dirs.flatMap((d) => this.manifestAt(d, repoRoot) ?? []);
    const listing = (pkg: string): { dev: boolean } | null => {
      for (const r of roots) {
        if (r.prod.has(pkg)) return { dev: false };
        if (r.dev.has(pkg)) return { dev: true };
      }
      return null;
    };
    const builtin = pythonBuiltin(module);
    const top = module.split('.')[0]!;
    const backports = builtin ? [...(STDLIB_BACKPORTS[top] ?? []), normalizeDist(`standard-${top}`)].filter((b) => listing(b)) : [];
    if (builtin && !backports.length) return { package: builtin, origin: 'builtin', direct: null, dev: null, attribution: null };
    const lock = this.lockFor(dirs, repoRoot);
    const broken = roots.some((r) => r.broken);
    const required = new Set(roots.flatMap((r) => [...r.prod.keys(), ...r.dev.keys()]));
    // Required distributions the lockfile lacks: it is stale and cannot tell about them.
    const missing = new Set(lock ? [...required].filter((r) => !lock.dev.has(r)) : []);
    const named = (d: string) => required.has(d) || !!lock?.dev.has(d);
    let found = null as string | null;
    let ambiguous = false as boolean;
    let wellKnown: readonly string[] | null = null;
    /** Decides among the candidates of one name; whether it settled the search. */
    const tryName = (candidates: string[]): boolean => {
      const confirmed = [...new Set(candidates)].filter(named);
      if (confirmed.length === 1) found = confirmed[0]!;
      else if (confirmed.length > 1) {
        for (const dev of [false, true]) {
          const listed = confirmed.filter((c) => listing(c)?.dev === dev);
          if (listed.length === 1) found = listed[0]!;
          if (listed.length) break;
        }
        ambiguous = !found;
      }
      return !!found || ambiguous;
    };
    if (backports.length) {
      tryName(backports);
    } else {
      const parts = module.split('.');
      const sub = symbol?.split('.')[0];
      const joined = sub && /^\w+$/.test(sub) ? `${module}.${sub}` : null;
      wellKnown = (joined && IMPORT_DISTRIBUTIONS[joined]) || null;
      for (let k = parts.length; k > 0; k--) {
        const prefix = parts.slice(0, k).join('.');
        const table = IMPORT_DISTRIBUTIONS[prefix];
        wellKnown ??= table ?? null;
        if (tryName([...(table ?? []), normalizeDist(prefix)])) break;
      }
      if (!found && !ambiguous && joined) tryName([...(IMPORT_DISTRIBUTIONS[joined] ?? []), normalizeDist(joined)]);
    }
    // The lock answered only when it was read, holds what the manifests require, and they could all be read.
    const backed = (pkg: string | null) => !!lock && !broken && (pkg ? !missing.has(pkg) : !missing.size);
    if (!found && !ambiguous && wellKnown?.length === 1 && !backed(null)) {
      return { package: wellKnown[0]!, origin: 'package', direct: broken ? null : false, dev: null, attribution: 'manifest' };
    }
    if (!found) return { package: null, origin: 'package', direct: null, dev: null, attribution: backed(null) || (ambiguous && !!lock && !broken) ? 'lock' : 'manifest' };
    const attribution = backed(found) ? 'lock' : 'manifest';
    const listed = listing(found);
    if (listed) return { package: found, origin: 'package', direct: true, dev: listed.dev, attribution };
    if (broken) return { package: found, origin: 'package', direct: null, dev: lock?.dev.get(found) ?? null, attribution };
    return { package: found, origin: 'package', direct: false, dev: lock?.dev.get(found) ?? null, attribution };
  }

  /**
   * A folder's manifests merged: its pyproject.toml and requirement files (`*requirements*.txt`,
   * `requirements/*.txt`); null when it has none. One that is there but cannot be read or parsed
   * marks the folder `broken`.
   */
  private manifestAt(dir: string, repoRoot: string): PyRoots | null {
    if (!this.manifests.has(dir)) {
      const roots: PyRoots = { prod: new Map(), dev: new Map() };
      let any = false;
      const path = inDir(dir, 'pyproject.toml');
      const text = this.read(path);
      if (text !== null) {
        any = true;
        try {
          const r = pyprojectRoots(parseToml(text));
          for (const [n, e] of r.prod) add(roots.prod, { name: n, extras: e });
          for (const [n, e] of r.dev) add(roots.dev, { name: n, extras: e });
          roots.poetry = r.poetry;
        } catch { roots.broken = true; }
      } else if (this.present(path)) {
        any = true;
        roots.broken = true;
      }
      const files: string[] = [];
      for (const [sub, glob] of [['', REQUIREMENTS_GLOB], ['requirements', '*.txt']] as const) {
        const folder = sub ? inDir(dir, sub) : dir;
        const listed = this.workspace.listDir?.(folder) ?? null;
        const matched = listed ? matchGlob(listed, glob) : [];
        this.reads.set(inDir(folder, glob), listed ? matched.join('\n') : null);
        files.push(...matched.map((f) => (sub ? `${sub}/${f}` : f)));
      }
      for (const f of files) {
        const into = requirementsFileIsDev(f) ? roots.dev : roots.prod;
        any = true;
        if (!this.requirements(inDir(dir, f), into, repoRoot, new Set())) roots.broken = true;
      }
      this.manifests.set(dir, any ? roots : null);
    }
    return this.manifests.get(dir)!;
  }

  /** Reads a requirements file and the files it includes (within the repo) into `into`; whether all of them could be read. */
  private requirements(path: string, into: Map<string, string[]>, repoRoot: string, seen: Set<string>): boolean {
    if (seen.has(path)) return true;
    seen.add(path);
    const text = this.read(path);
    if (text === null) return false;
    const { requirements, includes } = parseRequirementsTxt(text);
    for (const r of requirements) add(into, r);
    let ok = true;
    for (const inc of includes) {
      const target = posix.normalize(posix.join(posix.dirname(path), inc));
      const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
      if (!posix.isAbsolute(inc) && insideDir(dir, repoRoot) && !this.requirements(target, into, repoRoot, seen)) ok = false;
    }
    return ok;
  }

  /**
   * The nearest folder, from the file up to its repo's root, that holds uv.lock or poetry.lock, and its
   * first readable one. A lockfile that is there but cannot be read (a folder, no permission) ends the
   * walk as a corrupt one does: the manifests alone answer, never a parent folder's lockfile.
   */
  private lockFor(dirs: string[], repoRoot: string): PyLock | null {
    for (const dir of dirs) {
      if (!this.lockDirs.has(dir)) this.lockDirs.set(dir, PY_LOCKFILES.some((f) => this.present(inDir(dir, f))));
      if (!this.lockDirs.get(dir)) continue;
      if (!this.locks.has(dir)) this.locks.set(dir, this.readLock(dir, repoRoot));
      return this.locks.get(dir)!;
    }
    return null;
  }

  /** The folder's lockfile: poetry.lock first when its pyproject is Poetry's (review of M5-22), else uv.lock first. */
  private readLock(dir: string, repoRoot: string): PyLock | null {
    const manifest = this.manifestAt(dir, repoRoot);
    for (const f of manifest?.poetry ? [...PY_LOCKFILES].reverse() : PY_LOCKFILES) {
      const path = inDir(dir, f);
      const text = this.read(path);
      if (text === null) continue;
      try {
        return f === 'uv.lock' ? parseUvLock(text, path) : parsePoetryLock(text, manifest ? [manifest] : [], path);
      } catch { /* unreadable: try the next, else the manifests alone */ }
    }
    return null;
  }
}
