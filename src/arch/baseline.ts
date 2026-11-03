// Baselines and the `--compare` ratchet (M5-06; docs/research/deptrac AR-10).
//
// A baseline freezes the violations a codebase has today. Each violation it lists is reported as
// `skipped`. Each entry that matches no violation is an error (`stale-baseline`, exit 3), so the
// baseline can only shrink as the debt is paid.
//
//   {
//     "version": 1,
//     "entries": [                       // what `mapx check --generate-baseline` writes
//       { "fingerprint": "0816fbd611f92a81", "rule": "disallowed-layer",
//         "source": "App\\Domain\\Order", "target": "App\\Infrastructure\\SqlOrderRepository", "edgeType": "instantiation" }
//     ],
//     "skip_violations": {               // Deptrac's element pairs: any rule, any edge type
//       "App\\Domain\\Order": ["App\\Infrastructure\\SqlOrderRepository"]
//     }
//   }
//
// An entry needs a fingerprint, or all four readable keys (the fingerprint is computed from them),
// plus `sourceRepo`/`targetRepo` for an end in a repo other than the workspace's root repo. When
// both are given they must agree, so a hand edit cannot make the two say different things.
//
// `--compare <report.json>` is the ratchet without a committed baseline: a violation whose
// fingerprint the base revision's report contains is skipped, and nothing else is forgiven.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError, type ConfigIssue } from './config.js';
import type { ArchitectureConfig } from './schema.js';
import type { ElementView } from './elements.js';
import type { Finding } from './evaluate.js';
import type { Selection } from './report.js';

/**
 * A finding's stable identity (AR-09): the first 16 hex characters of sha256 over
 * `[rule, source, target, edge type]`, plus `[source repo, target repo]` when either end is in a
 * repo other than the workspace's root repo.
 * - **Ends** are the reported element's qualified name, or, for an end the edge names at file level
 *   (an import's importing file, an import path's target file), the workspace-relative file path.
 *   A file-level end is never named after the file's only top-level symbol here, so adding a
 *   second symbol to either file keeps the fingerprint (review of M5-06).
 * - **Paths** are POSIX and workspace-relative (the store records `/` on every OS), and a repo is
 *   its workspace-relative path, the root repo being '' and left out: the value is the same on
 *   every machine and checkout, and a single-repo workspace never names its repo.
 * - **No line number and no layer:** moving code, re-scanning or editing the layers keeps it.
 * - **What does re-key it:** renaming or moving a class, and moving a file whose language names
 *   elements by path (TypeScript and JavaScript `src/a.ts#Name`, file-level ends everywhere). That
 *   is a new dependency to the baseline, by design.
 */
export function fingerprint(rule: string, source: string, target: string, edgeType: string, sourceRepo = '', targetRepo = ''): string {
  const parts = sourceRepo || targetRepo ? [rule, source, target, edgeType, sourceRepo, targetRepo] : [rule, source, target, edgeType];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** A repo as a fingerprint names it: its workspace-relative POSIX path; '' for the root repo. */
export function repoKey(name: string | undefined, repoPaths: Record<string, string>): string {
  if (!name) return '';
  const path = repoPaths[name];
  if (path === undefined) return Object.keys(repoPaths).length ? name : ''; // no repo list: one repo
  if (isAbsolute(path)) return name; // a peer repo outside the workspace: its name, not this machine's path
  const p = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return p === '.' ? '' : p; // '' too: the root repo
}

const FINGERPRINT = /^[0-9a-f]{16}$/;
const ENTRY_KEYS = ['fingerprint', 'rule', 'source', 'target', 'edgeType', 'sourceRepo', 'targetRepo'] as const;
const TOP_KEYS = ['$schema', 'version', 'entries', 'skip_violations'];
/** Errors about the configuration or the baseline (check.ts CONFIG_RULES): never known to `--compare`. */
const BASE_ERROR_RULES = new Set(['config', 'plus-cycle', 'stale-baseline']);
/** The fingerprint of a Deptrac element pair, for its stale-entry error. */
const PAIR_RULE = 'skip_violations';

export interface BaselineEntry {
  fingerprint: string;
  rule?: string;
  source?: string;
  target?: string;
  edgeType?: string;
  sourceRepo?: string;
  targetRepo?: string;
  /** Where the entry is in its file (`/entries/3`): the location of its stale-entry error (M5-07). */
  pointer?: string;
}

export interface Baseline {
  /** The file, relative to the workspace when inside it. */
  file: string;
  entries: BaselineEntry[];
  /** Deptrac element pairs: source element → target elements. */
  pairs: Array<{ source: string; target: string; pointer?: string }>;
}

/**
 * A hand-written element name as the store spells it: a file path (or the path part of a
 * `path#Scope.Name` qualified name) with `\` separators, typed on Windows, gets `/`. The path part
 * is recognised by a `.` in its last segment (`src\a\Order.ts`); a PHP qualified name has none
 * (`App\Domain\Order`), so it keeps its backslashes.
 */
export function normalizeElement(name: string): string {
  const hash = name.indexOf('#');
  const path = hash < 0 ? name : name.slice(0, hash);
  if (!path.includes('\\') || !path.slice(path.lastIndexOf('\\') + 1).includes('.')) return name;
  return path.replace(/\\/g, '/') + (hash < 0 ? '' : name.slice(hash));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pointer = (...parts: Array<string | number>) => parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Parses and validates a baseline document; every problem is a ConfigError issue (exit 3). */
export function parseBaseline(text: string, file: string): Baseline {
  const issues: ConfigIssue[] = [];
  const issue = (p: string, message: string) => issues.push({ file, pointer: p, message });
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, '')); // a BOM from a Windows editor, as config.ts allows
  } catch (err) {
    throw new ConfigError([{ file, pointer: '', message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }]);
  }
  if (!isObject(doc)) throw new ConfigError([{ file, pointer: '', message: 'expected an object with "entries" or "skip_violations"' }]);
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) issue(pointer(key), `unknown key "${key}"; expected one of ${TOP_KEYS.join(', ')}`);
  if (doc.version !== undefined && doc.version !== 1) issue('/version', 'expected 1');

  const entries: BaselineEntry[] = [];
  if (doc.entries !== undefined && !Array.isArray(doc.entries)) issue('/entries', 'expected a list of entries');
  for (const [i, raw] of (Array.isArray(doc.entries) ? doc.entries : []).entries()) {
    if (!isObject(raw)) { issue(pointer('entries', i), 'expected an object'); continue; }
    let ok = true;
    for (const [k, v] of Object.entries(raw)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(k)) { issue(pointer('entries', i, k), `unknown key "${k}"; expected one of ${ENTRY_KEYS.join(', ')}`); ok = false; }
      else if (typeof v !== 'string' || !v) { issue(pointer('entries', i, k), 'expected a non-empty string'); ok = false; }
    }
    if (!ok) continue;
    const e = { ...raw } as Partial<Record<typeof ENTRY_KEYS[number], string>>;
    if (e.source) e.source = normalizeElement(e.source);
    if (e.target) e.target = normalizeElement(e.target);
    const keyed = e.rule !== undefined && e.source !== undefined && e.target !== undefined && e.edgeType !== undefined;
    const computed = keyed ? fingerprint(e.rule!, e.source!, e.target!, e.edgeType!, e.sourceRepo, e.targetRepo) : undefined;
    if (e.fingerprint !== undefined && !FINGERPRINT.test(e.fingerprint)) { issue(pointer('entries', i, 'fingerprint'), 'expected 16 lowercase hex characters'); continue; }
    if (!e.fingerprint && !keyed) { issue(pointer('entries', i), 'needs a fingerprint, or all of rule, source, target and edgeType'); continue; }
    if (!keyed && (e.sourceRepo || e.targetRepo)) { issue(pointer('entries', i), 'sourceRepo and targetRepo need rule, source, target and edgeType'); continue; }
    if (e.fingerprint && computed && e.fingerprint !== computed) {
      issue(pointer('entries', i, 'fingerprint'), `${e.fingerprint} is not the fingerprint of its rule, source, target, edgeType and repos (${computed}); regenerate the baseline or fix the entry`);
      continue;
    }
    entries.push({ ...e, fingerprint: e.fingerprint ?? computed!, pointer: pointer('entries', i) });
  }

  const pairs: Baseline['pairs'] = [];
  if (doc.skip_violations !== undefined && !isObject(doc.skip_violations)) issue('/skip_violations', 'expected an object of source element → list of target elements');
  for (const [source, targets] of Object.entries(isObject(doc.skip_violations) ? doc.skip_violations : {})) {
    if (!Array.isArray(targets)) { issue(pointer('skip_violations', source), 'expected a list of target elements'); continue; }
    targets.forEach((t, i) => {
      if (typeof t !== 'string' || !t) issue(pointer('skip_violations', source, i), 'expected a non-empty string');
      else pairs.push({ source: normalizeElement(source), target: normalizeElement(t), pointer: pointer('skip_violations', source, i) });
    });
  }
  if (issues.length) throw new ConfigError(issues);
  // A repeated entry is one entry: it matches, or goes stale, once.
  const seen = new Set<string>();
  const pairSeen = new Set<string>();
  return {
    file,
    entries: entries.filter((e) => !seen.has(e.fingerprint) && seen.add(e.fingerprint)),
    pairs: pairs.filter((p) => { const k = JSON.stringify([p.source, p.target]); return !pairSeen.has(k) && pairSeen.add(k); }),
  };
}

/** `path` relative to the workspace when inside it (POSIX separators), else absolute. */
export function displayPath(dir: string, path: string): string {
  const rel = relative(dir, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path;
}

/** Where a view's baseline lives when the configuration names none. */
export function defaultBaselinePath(dir: string, view?: string | null): string {
  return view ? join(dir, '.mapx', 'architecture', `${view}.baseline.json`) : join(dir, '.mapx', 'architecture.baseline.json');
}

/**
 * The baseline a check uses: `override` (an absolute path, `--baseline`), else the configuration's
 * `baseline` (relative to the workspace), else the default file. `required` says whether a missing
 * file is an error: a named one is, the default one is simply absent.
 */
export function baselineLocation(dir: string, config: ArchitectureConfig, override?: string): { path: string; required: boolean } {
  if (override) return { path: resolve(override), required: true };
  if (config.baseline) return { path: resolve(dir, config.baseline), required: true };
  return { path: defaultBaselinePath(dir, config.view), required: false };
}

/**
 * `path` relative to the workspace, with `/`, even outside it (`../ci/baseline.json`): reports name
 * the baseline this way, never by an absolute path that differs per machine (review of M5-07). A
 * path on another Windows drive, which has no relative form, is named by its file name.
 */
export function workspacePath(dir: string, path: string): string {
  const rel = relative(dir, path);
  return isAbsolute(rel) ? basename(path) : rel.split(sep).join('/');
}

/** Reads the baseline a check uses; null when there is none. Problems are ConfigErrors. */
export function loadBaseline(dir: string, config: ArchitectureConfig, override?: string): Baseline | null {
  const { path, required } = baselineLocation(dir, config, override);
  const file = workspacePath(dir, path);
  if (!existsSync(path)) {
    if (!required) return null;
    throw new ConfigError([{ file, pointer: '', message: 'baseline file not found; create it with `mapx check --generate-baseline`' }]);
  }
  return parseBaseline(readFileSync(path, 'utf8'), file);
}

/** Matches violations against a baseline and remembers which entries matched. */
export class BaselineMatcher {
  private readonly byFingerprint = new Map<string, BaselineEntry>();
  private readonly byPair = new Map<string, Baseline['pairs'][number]>();
  private readonly matched = new Set<object>();

  constructor(readonly baseline: Baseline) {
    for (const e of baseline.entries) this.byFingerprint.set(e.fingerprint, e);
    for (const p of baseline.pairs) this.byPair.set(JSON.stringify([p.source, p.target]), p);
  }

  /** Does the baseline accept this violation? Every entry that does counts as matched. */
  match(f: Finding): boolean {
    const entry = this.byFingerprint.get(f.fingerprint);
    const pair = f.source && f.target
      ? this.byPair.get(JSON.stringify([f.source.element, f.target.element])) ?? this.byPair.get(JSON.stringify([identityOf(f).source, identityOf(f).target]))
      : undefined;
    if (entry) this.matched.add(entry);
    if (pair) this.matched.add(pair);
    return !!(entry || pair);
  }

  /**
   * One `stale-baseline` error per entry that matched nothing; ends resolved to files when they
   * still exist. Its `location` is the entry in the baseline file (relative, with a JSON pointer),
   * which is what has to change; the message names it the same way (review of M5-07).
   */
  stale(view?: ElementView, repoPaths: Record<string, string> = {}): Finding[] {
    const fileOf = elementFiles(view, repoPaths);
    const end = (element: string, repo = '') => ({ element, file: fileOf.get(`${repo}\u0000${element}`) ?? fileOf.get(`*\u0000${element}`) ?? '' });
    const at = (ptr?: string) => ({ location: { file: this.baseline.file, ...(ptr ? { pointer: ptr } : {}) } });
    const where = (ptr?: string) => `${this.baseline.file}${ptr ? `#${ptr}` : ''}`;
    const out: Finding[] = [];
    for (const e of this.baseline.entries) {
      if (this.matched.has(e)) continue;
      const repos = e.sourceRepo || e.targetRepo ? `, repos ${e.sourceRepo || '.'} → ${e.targetRepo || '.'}` : '';
      const what = e.source && e.target ? `${e.rule} ${e.source} → ${e.target} (${e.edgeType}${repos})` : e.fingerprint;
      out.push({
        kind: 'error', rule: 'stale-baseline', severity: 'error',
        ...(e.source ? { source: end(e.source, e.sourceRepo) } : {}), ...(e.target ? { target: end(e.target, e.targetRepo) } : {}),
        ...(e.edgeType ? { edgeType: e.edgeType } : {}),
        fingerprint: e.fingerprint,
        ...at(e.pointer),
        message: `${where(e.pointer)}: the baseline entry ${what} matches no violation; delete it`,
      });
    }
    for (const p of this.baseline.pairs) {
      if (this.matched.has(p)) continue;
      out.push({
        kind: 'error', rule: 'stale-baseline', severity: 'error', source: end(p.source), target: end(p.target),
        fingerprint: fingerprint(PAIR_RULE, p.source, p.target, ''),
        ...at(p.pointer),
        message: `${where(p.pointer)}: skip_violations ${p.source} → ${p.target} matches no violation; delete it`,
      });
    }
    return out;
  }
}

/**
 * `<repo key>\0<element>` → its file (top-level symbols by qualified name, files by path), and
 * `*\0<element>` for the first repo that has it.
 */
function elementFiles(view: ElementView | undefined, repoPaths: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  if (!view) return files;
  const add = (repo: string, name: string, file: string) => {
    if (!files.has(`${repo}\u0000${name}`)) files.set(`${repo}\u0000${name}`, file);
    if (!files.has(`*\u0000${name}`)) files.set(`*\u0000${name}`, file);
  };
  for (const e of view.elements) {
    const repo = repoKey(e.file.repo, repoPaths);
    if (e.kind === 'file') add(repo, e.file.path, e.file.path);
    else if (e.topLevel) add(repo, e.qualifiedName, e.file.path);
  }
  return files;
}

/** The fingerprint's inputs of a finding: its `identity` when it has one, else its shown elements. */
export function identityOf(f: Finding): { source: string; target: string; sourceRepo: string; targetRepo: string } {
  return {
    source: f.identity?.source ?? f.source?.element ?? '',
    target: f.identity?.target ?? f.target?.element ?? '',
    sourceRepo: f.identity?.sourceRepo ?? '',
    targetRepo: f.identity?.targetRepo ?? '',
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The baseline of a report's violations, as `--generate-baseline` writes it: one entry per
 * fingerprint, sorted by code units (never by locale), two-space JSON with a final newline and
 * no timestamp, so the same violations always give the same bytes.
 */
export function renderBaseline(findings: Finding[]): string {
  const entries = new Map<string, BaselineEntry & { rule: string; source: string; target: string; edgeType: string }>();
  for (const f of findings) {
    if (f.kind !== 'violation' || !f.source || !f.target || !f.rule || !f.edgeType) continue;
    const id = identityOf(f);
    entries.set(f.fingerprint, {
      fingerprint: f.fingerprint, rule: f.rule, source: id.source, target: id.target, edgeType: f.edgeType,
      ...(id.sourceRepo || id.targetRepo ? { sourceRepo: id.sourceRepo, targetRepo: id.targetRepo } : {}),
    });
  }
  const sorted = [...entries.values()].sort((a, b) => cmp(a.rule, b.rule) || cmp(a.sourceRepo ?? '', b.sourceRepo ?? '') || cmp(a.source, b.source)
    || cmp(a.targetRepo ?? '', b.targetRepo ?? '') || cmp(a.target, b.target) || cmp(a.edgeType, b.edgeType) || cmp(a.fingerprint, b.fingerprint));
  return `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`;
}

/**
 * The fingerprints of a base revision's report (`mapx check --format json` on the merge base) for
 * `--compare`. Every finding counts, whatever its kind, but configuration and baseline errors.
 * When `head` is given, a base made on another view, or narrowed by a `--layer` or `--rule` the head
 * does not share, is refused: its missing findings would look new, or a view's findings would
 * excuse another's (review of M5-06). A report without a selection (before M5-06) is not checked.
 * Problems are ConfigErrors (exit 3).
 */
export function loadCompareReport(path: string, display = path, head?: Selection): Set<string> {
  const fail = (message: string): never => { throw new ConfigError([{ file: display, pointer: '', message }]); };
  if (!existsSync(path)) fail('report not found (write it with `mapx check --format json -o <file>` on the base revision)');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    fail(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.findings)) fail('not a `mapx check --format json` report (version 1 with findings)');
  const base = (doc as { selection?: unknown }).selection;
  if (head && isObject(base)) {
    const name = (v: unknown) => (typeof v === 'string' ? `"${v}"` : 'none');
    if ((base.view ?? null) !== head.view) fail(`the base report checked view ${name(base.view)}, this check view ${name(head.view)}; compare like with like`);
    for (const k of ['layer', 'rule'] as const) {
      if (base[k] != null && base[k] !== head[k]) fail(`the base report was narrowed by --${k} ${name(base[k])}, so it lacks findings this check has; make it without --${k}, or pass the same --${k}`);
    }
  }
  const known = new Set<string>();
  for (const [i, f] of ((doc as { findings: unknown[] }).findings).entries()) {
    if (!isObject(f) || typeof f.fingerprint !== 'string' || !FINGERPRINT.test(f.fingerprint)) {
      throw new ConfigError([{ file: display, pointer: pointer('findings', i, 'fingerprint'), message: 'expected a 16-hex-character fingerprint' }]);
    }
    // A base error about the configuration or the baseline forgives nothing: a stale entry carries
    // the fingerprint of the violation it names, which must still fail if it comes back.
    if (f.kind === 'error' && typeof f.rule === 'string' && BASE_ERROR_RULES.has(f.rule)) continue;
    known.add(f.fingerprint);
  }
  return known;
}
