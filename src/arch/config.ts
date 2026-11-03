// Loads the architecture configuration (M5-02; AR-11, AR-14, AR-05): `.mapx/architecture.jsonc` or a
// view `.mapx/architecture/<view>.jsonc`, with `extends` (files and `mapx:preset/<id>`), `%parameter%`
// substitution and validation. Every problem is reported at once, each with the file and a JSON
// pointer, in document order; a configuration with any problem throws a ConfigError.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stripJsonc } from '../core/js-aliases.js';
import {
  ALLOWANCE_KEYS, CODECLIMATE_KEYS, CODECLIMATE_SEVERITIES, DEFAULTS, DEFAULT_SCOPE_TYPES, EDGE_TYPES, FRAMEWORK_PARTS, LAYER_KEYS, POLICY_KEYS, REPORT_KEYS, SCOPE_KEYS,
  SELECTOR_KEYS, SELECTOR_MODIFIERS, SELECTOR_PRIMARY_KEYS, SYMBOL_KINDS, TOP_LEVEL_KEYS, UNCOVERED_KEYS, VISIBILITY_KEYS,
  type Allowance, type ArchitectureConfig, type ArchitectureDocument, type Layer, type Selector,
} from './schema.js';

export interface ConfigIssue {
  /** The document, relative to the workspace when inside it (`mapx:preset/<id>` for presets). */
  file: string;
  /** JSON pointer into that document (RFC 6901). */
  pointer: string;
  message: string;
}

/** A configuration that cannot be used; `issues` lists every problem (M5-05 exits with code 3). */
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`Invalid architecture configuration:\n${issues.map((i) => `  ${i.file}${i.pointer ? `#${i.pointer}` : ''}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Built-in presets by id (`mapx:preset/<id>`), as JSONC text or a document. M5-17 fills it. */
export type PresetRegistry = Record<string, string | ArchitectureDocument>;
export const PRESETS: PresetRegistry = {};
const PRESET_PREFIX = 'mapx:preset/';

export interface LoadOptions {
  /** A view: `.mapx/architecture/<view>.jsonc` instead of `.mapx/architecture.jsonc` (AR-14). */
  view?: string;
  presets?: PresetRegistry;
}

/** The configuration file of the workspace at `dir` (or of one of its views). */
export function architectureConfigPath(dir: string, view?: string | null): string {
  return view ? join(dir, '.mapx', 'architecture', `${view}.jsonc`) : join(dir, '.mapx', 'architecture.jsonc');
}

/** Is `path` inside `base`? `..legacy` is a name inside; only a `..` segment leaves. */
function isInside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/**
 * Why `view` cannot name a view: it is empty, or its file lies outside `.mapx/architecture/`,
 * by name (`../../x`) or through a symlink. A path that cannot be resolved is left to the loader.
 */
function viewProblem(dir: string, view: string): ConfigIssue | null {
  const where = { file: '.mapx/architecture', pointer: '' };
  if (!view.trim()) return { ...where, message: 'empty view name: a view is a file name in .mapx/architecture/, such as "contexts" for .mapx/architecture/contexts.jsonc' };
  const views = join(dir, '.mapx', 'architecture');
  const file = architectureConfigPath(dir, view);
  let inside = isInside(views, file);
  if (inside) {
    try {
      inside = isInside(realpathSync(views), realpathSync(file));
    } catch { /* missing or unreadable: reported when it is loaded */ }
  }
  return inside ? null : { ...where, message: `view ${quote(view)} is outside .mapx/architecture/: a view is a file name there, such as "contexts" for .mapx/architecture/contexts.jsonc` };
}

/** A filesystem error in words, with its code (M5-02-R1: every one is a configuration problem). */
function fsReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const words: Record<string, string> = {
    EISDIR: 'it is a directory, not a file',
    EACCES: 'permission denied',
    EPERM: 'permission denied',
    ELOOP: 'too many symbolic links (a symlink loop)',
    ENOTDIR: 'a part of the path is not a directory',
  };
  if (code && words[code]) return `${words[code]} (${code})`;
  return err instanceof Error ? err.message : String(err);
}

const escapePointer = (token: string | number) => String(token).replace(/~/g, '~0').replace(/\//g, '~1');
const at = (pointer: string, ...tokens: Array<string | number>) => pointer + tokens.map((t) => '/' + escapePointer(t)).join('');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const quote = (s: string) => JSON.stringify(s);
/** A doc tag as `visibility.internalTags` takes it: the block-tag names the parsers store, `@` optional. */
const DOC_TAG = /^@?[A-Za-z_][\w\\.:-]*$/;

// ─── Parsing ─────────────────────────────────────────────────────────────────────────────────

/** Parses JSONC text (the dialect `workspaces` and tsconfig use); a syntax error is one issue with its line and column. */
export function parseArchitectureText(text: string, file: string): { doc: unknown; issues: ConfigIssue[] } {
  // A UTF-8 BOM (some Windows editors write one) is not JSON whitespace (M5-02-R1).
  const stripped = stripJsonc(text.replace(/^\uFEFF/, ''));
  try {
    return { doc: JSON.parse(stripped), issues: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pos = /position (\d+)/.exec(message);
    let where = '';
    if (pos) {
      const before = stripped.slice(0, Number(pos[1]));
      const line = before.split('\n').length;
      where = ` at line ${line}, column ${Number(pos[1]) - before.lastIndexOf('\n')}`;
    }
    return { doc: null, issues: [{ file, pointer: '', message: `not valid JSONC${where}: ${message.replace(/ in JSON at position \d+.*$/, '')}` }] };
  }
}

// ─── Structural validation of one document ───────────────────────────────────────────────────

/** Problems in one document's shape: unknown keys, wrong types, unknown edge types and selector keys. */
export function validateDocument(doc: unknown, file: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (pointer: string, message: string) => issues.push({ file, pointer, message });
  if (!isObject(doc)) {
    issue('', 'the document must be a JSON object');
    return issues;
  }
  const knownKeys = (obj: Record<string, unknown>, pointer: string, keys: readonly string[], what: string) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key)) issue(at(pointer, key), `unknown ${what} key ${quote(key)}; expected one of ${keys.join(', ')}`);
  };
  const stringList = (value: unknown, pointer: string, what = 'a list of strings') => {
    if (!Array.isArray(value)) return issue(pointer, `expected ${what}`);
    value.forEach((v, i) => { if (typeof v !== 'string' || !v) issue(at(pointer, i), 'expected a non-empty string'); });
  };
  const edgeTypes = (value: unknown, pointer: string) => {
    if (!Array.isArray(value)) return issue(pointer, 'expected a list of edge types');
    value.forEach((v, i) => {
      if (!EDGE_TYPES.includes(v as never)) issue(at(pointer, i), `unknown edge type ${quote(String(v))}; expected one of ${EDGE_TYPES.join(', ')}`);
    });
  };
  const bool = (value: unknown, pointer: string) => { if (typeof value !== 'boolean') issue(pointer, 'expected true or false'); };

  for (const [key, value] of Object.entries(doc)) {
    const p = at('', key);
    switch (key) {
      case '$schema':
      case 'baseline':
        if (typeof value !== 'string' || !value) issue(p, 'expected a non-empty string');
        break;
      case 'extends':
        if (typeof value === 'string') { if (!value) issue(p, 'expected a non-empty string'); } else stringList(value, p, 'a file, a preset id, or a list of them');
        break;
      case 'parameters':
        if (!isObject(value)) issue(p, 'expected an object of name → string value');
        else for (const [name, v] of Object.entries(value)) if (typeof v !== 'string') issue(at(p, name), 'expected a string value');
        break;
      case 'scope':
        if (!isObject(value)) { issue(p, 'expected an object'); break; }
        knownKeys(value, p, SCOPE_KEYS, 'scope');
        if ('types' in value) edgeTypes(value['types'], at(p, 'types'));
        if ('include' in value) stringList(value['include'], at(p, 'include'), 'a list of path globs');
        if ('exclude' in value) stringList(value['exclude'], at(p, 'exclude'), 'a list of path globs');
        break;
      case 'policy':
        if (!isObject(value)) { issue(p, 'expected an object'); break; }
        knownKeys(value, p, POLICY_KEYS, 'policy');
        if ('inferred' in value && !['error', 'warn', 'ignore'].includes(value['inferred'] as string)) issue(at(p, 'inferred'), 'expected "error", "warn" or "ignore"');
        if ('inheritDependencies' in value) bool(value['inheritDependencies'], at(p, 'inheritDependencies'));
        if ('strictLayers' in value) bool(value['strictLayers'], at(p, 'strictLayers'));
        if ('uncovered' in value) {
          const u = value['uncovered'];
          if (!isObject(u)) issue(at(p, 'uncovered'), 'expected an object');
          else {
            knownKeys(u, at(p, 'uncovered'), UNCOVERED_KEYS, 'policy.uncovered');
            for (const k of UNCOVERED_KEYS) if (k in u) bool(u[k], at(p, 'uncovered', k));
          }
        }
        break;
      case 'visibility':
        if (!isObject(value)) { issue(p, 'expected an object'); break; }
        knownKeys(value, p, VISIBILITY_KEYS, 'visibility');
        if ('internalTags' in value) {
          stringList(value['internalTags'], at(p, 'internalTags'), 'a list of doc tags');
          // A tag as the parsers store it (`@name`, the `@` optional): anything else never matches (M5-11).
          if (Array.isArray(value['internalTags'])) value['internalTags'].forEach((t, i) => {
            if (typeof t === 'string' && t && !DOC_TAG.test(t)) issue(at(p, 'internalTags', i), `expected a doc tag such as "@internal", got ${quote(t)}`);
          });
        }
        if ('nativeMarkers' in value) bool(value['nativeMarkers'], at(p, 'nativeMarkers'));
        break;
      case 'layers':
        if (!Array.isArray(value)) { issue(p, 'expected a list of layers'); break; }
        value.forEach((layer, i) => validateLayer(layer, at(p, i), issue, knownKeys));
        break;
      case 'rules':
        if (!isObject(value)) { issue(p, 'expected an object of layer → allowances'); break; }
        for (const [source, list] of Object.entries(value)) {
          const lp = at(p, source);
          if (!Array.isArray(list)) { issue(lp, 'expected a list of allowances'); continue; }
          list.forEach((a, i) => validateAllowance(a, at(lp, i), issue, knownKeys, edgeTypes));
        }
        break;
      case 'report':
        if (!isObject(value)) { issue(p, 'expected an object'); break; }
        knownKeys(value, p, REPORT_KEYS, 'report');
        if ('groups' in value) {
          const g = value['groups'];
          if (!isObject(g)) issue(at(p, 'groups'), 'expected an object of group → layers');
          else for (const [name, layers] of Object.entries(g)) stringList(layers, at(p, 'groups', name), 'a list of layer names');
        }
        if ('hidden' in value) stringList(value['hidden'], at(p, 'hidden'), 'a list of layer names');
        if ('pointToGroups' in value && typeof value['pointToGroups'] !== 'boolean') issue(at(p, 'pointToGroups'), 'expected true or false');
        if ('codeclimate' in value) {
          // The CodeClimate severity map (M5-07): finding severity or kind → CodeClimate severity.
          const cc = value['codeclimate'];
          const cp = at(p, 'codeclimate');
          if (!isObject(cc)) issue(cp, `expected an object of ${CODECLIMATE_KEYS.join(', ')} → severity`);
          else {
            knownKeys(cc, cp, CODECLIMATE_KEYS, 'report.codeclimate');
            for (const [k, v] of Object.entries(cc)) {
              if (CODECLIMATE_KEYS.includes(k as never) && !CODECLIMATE_SEVERITIES.includes(v as never)) issue(at(cp, k), `expected one of ${CODECLIMATE_SEVERITIES.join(', ')}`);
            }
          }
        }
        break;
      default:
        issue(p, `unknown key ${quote(key)}; expected one of ${TOP_LEVEL_KEYS.join(', ')}`);
    }
  }
  return issues;
}

type IssueFn = (pointer: string, message: string) => void;
type KnownKeysFn = (obj: Record<string, unknown>, pointer: string, keys: readonly string[], what: string) => void;

function validateLayer(layer: unknown, p: string, issue: IssueFn, knownKeys: KnownKeysFn) {
  if (!isObject(layer)) return issue(p, 'expected a layer object { name, selectors }');
  knownKeys(layer, p, LAYER_KEYS, 'layer');
  if (typeof layer['name'] !== 'string' || !layer['name']) issue(at(p, 'name'), 'a layer needs a non-empty name');
  else if (layer['name'] === '*' || /^[+!]/.test(layer['name'])) issue(at(p, 'name'), `${quote(layer['name'])} is not a usable layer name: "*", "+" and "!" have a meaning in rules`);
  for (const key of ['description', 'group', 'color'] as const) {
    if (key in layer && typeof layer[key] !== 'string') issue(at(p, key), 'expected a string');
  }
  if ('overlay' in layer && typeof layer['overlay'] !== 'boolean') issue(at(p, 'overlay'), 'expected true or false');
  if (!('selectors' in layer)) issue(p, 'a layer needs selectors');
  else if (!Array.isArray(layer['selectors'])) issue(at(p, 'selectors'), 'expected a list of selectors');
  else layer['selectors'].forEach((s, i) => validateSelector(s, at(p, 'selectors', i), issue));
  if ('private' in layer) {
    if (!Array.isArray(layer['private'])) issue(at(p, 'private'), 'expected a list of selectors');
    else layer['private'].forEach((s, i) => validateSelector(s, at(p, 'private', i), issue));
  }
}

const STRING_SELECTORS = new Set(['path', 'name', 'extends', 'implements', 'inherits', 'mixes', 'decorator', 'docTag', 'value', 'member', 'package', 'role', 'cluster', 'repo', 'workspacePackage', 'language', 'layer']);

function validateSelector(sel: unknown, p: string, issue: IssueFn) {
  if (!isObject(sel)) return issue(p, 'expected a selector object, e.g. { "path": "app/Http/**" }');
  const keys = Object.keys(sel);
  for (const key of keys) {
    if (!SELECTOR_KEYS.includes(key)) issue(at(p, key), `unknown selector key ${quote(key)}; expected one of ${SELECTOR_KEYS.join(', ')}`);
  }
  const primaries = keys.filter((k) => (SELECTOR_PRIMARY_KEYS as readonly string[]).includes(k));
  // No primary key: say so, unless an unknown key or a lone modifier already explains it.
  if (primaries.length === 0 && keys.every((k) => SELECTOR_KEYS.includes(k) && !SELECTOR_MODIFIERS[k])) issue(p, `a selector needs one of ${SELECTOR_PRIMARY_KEYS.join(', ')}`);
  if (primaries.length > 1) issue(p, `a selector has one of ${primaries.join(', ')}, not several; combine them with { "all": [...] }`);
  for (const key of keys) {
    const owner = SELECTOR_MODIFIERS[key];
    if (owner && !keys.includes(owner)) issue(at(p, key), `${quote(key)} refines a ${quote(owner)} selector; add ${quote(owner)} or remove it`);
  }
  for (const [key, value] of Object.entries(sel)) {
    const kp = at(p, key);
    if (STRING_SELECTORS.has(key)) {
      if (typeof value !== 'string' || !value) issue(kp, 'expected a non-empty string');
    } else if (key === 'kind') {
      if (!Array.isArray(value)) issue(kp, 'expected a list of symbol kinds');
      else value.forEach((k, i) => { if (!SYMBOL_KINDS.includes(k)) issue(at(kp, i), `unknown symbol kind ${quote(String(k))}; expected one of ${SYMBOL_KINDS.join(', ')}`); });
    } else if (key === 'inheritanceDepth') {
      if (!Number.isInteger(value) || (value as number) < 1) issue(kp, 'expected a whole number ≥ 1');
    } else if (key === 'confidence') {
      if (typeof value !== 'number' || value < 0 || value > 1) issue(kp, 'expected a number from 0 to 1');
    } else if (key === 'dev' || key === 'direct') {
      if (typeof value !== 'boolean') issue(kp, 'expected true or false');
    } else if (key === 'builtin' || key === 'ambient') {
      if (value !== true && (typeof value !== 'string' || !value)) issue(kp, 'expected true or a name pattern');
    } else if (key === 'framework') {
      // `%param%` is checked after substitution, when the parameters of the whole chain are known.
      if (!(typeof value === 'string' && PARAMETER_REF.test(value)) && !FRAMEWORK_PARTS.includes(value as never)) issue(kp, unknownFramework(value));
    } else if (key === 'all' || key === 'any') {
      if (!Array.isArray(value) || value.length === 0) issue(kp, 'expected a non-empty list of selectors');
      else value.forEach((s, i) => validateSelector(s, at(kp, i), issue));
    } else if (key === 'not') {
      validateSelector(value, kp, issue);
    }
  }
}

const unknownFramework = (value: unknown) => `unknown framework part ${quote(String(value))}; expected one of ${FRAMEWORK_PARTS.join(', ')}`;

const ALLOWANCE_STRING = /^([+!])?(.+)$/;

function validateAllowanceString(value: unknown, p: string, issue: IssueFn) {
  if (typeof value !== 'string' || !value) return issue(p, 'expected a layer name, "+Layer", "!Layer" or "*"');
  const m = ALLOWANCE_STRING.exec(value)!;
  if (m[1] && m[2] === '*') issue(p, `${quote(value)} is not an allowance: "*" takes no "${m[1]}"`);
}

function validateAllowance(a: unknown, p: string, issue: IssueFn, knownKeys: KnownKeysFn, edgeTypes: (v: unknown, p: string) => void) {
  if (typeof a === 'string') return validateAllowanceString(a, p, issue);
  if (!isObject(a)) return issue(p, 'expected a layer name or an object { allow, types?, severity? }');
  knownKeys(a, p, ALLOWANCE_KEYS, 'allowance');
  const hasAllow = 'allow' in a;
  const hasTo = 'to' in a;
  if (hasAllow === hasTo) issue(p, 'an allowance object needs "allow" (a list) or "to" (one layer), not both');
  if (hasAllow) {
    if (!Array.isArray(a['allow']) || a['allow'].length === 0) issue(at(p, 'allow'), 'expected a non-empty list of layers');
    else a['allow'].forEach((v, i) => validateAllowanceString(v, at(p, 'allow', i), issue));
  }
  if (hasTo) validateAllowanceString(a['to'], at(p, 'to'), issue);
  if ('types' in a) edgeTypes(a['types'], at(p, 'types'));
  if ('severity' in a && a['severity'] !== 'error' && a['severity'] !== 'warn') issue(at(p, 'severity'), 'expected "error" or "warn"');
}

// ─── Loading the extends chain ───────────────────────────────────────────────────────────────

interface LoadedDoc { file: string; doc: ArchitectureDocument; order: Map<string, number> }

/** Pre-order position of every pointer in a parsed document: issues sort by it (document order). */
function pointerOrder(doc: unknown): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (value: unknown, pointer: string) => {
    order.set(pointer, order.size);
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, at(pointer, i)));
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, at(pointer, k));
  };
  walk(doc, '');
  return order;
}

class Loader {
  readonly docs: LoadedDoc[] = [];
  readonly issues: ConfigIssue[] = [];
  private readonly done = new Set<string>();

  constructor(private readonly workspace: string, private readonly presets: PresetRegistry) {}

  display(file: string) {
    if (file.startsWith(PRESET_PREFIX)) return file;
    const rel = relative(this.workspace, file);
    return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
  }

  /** Loads `file` and, first, every document it extends (depth-first; each document once). */
  load(file: string, stack: string[]) {
    if (this.done.has(file)) return;
    const shown = this.display(file);
    let text: string | ArchitectureDocument;
    if (file.startsWith(PRESET_PREFIX)) {
      const preset = this.presets[file.slice(PRESET_PREFIX.length)];
      if (preset === undefined) return; // reported by the extending document
      text = preset;
    } else {
      // A directory or an unreadable file is a problem to report, not an EISDIR crash (M5-02-R1).
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        this.issues.push({ file: shown, pointer: '', message: `cannot be read: ${fsReason(err)}` });
        this.done.add(file);
        return;
      }
    }
    let doc: unknown;
    if (typeof text === 'string') {
      const parsed = parseArchitectureText(text, shown);
      if (parsed.issues.length) { this.issues.push(...parsed.issues); this.done.add(file); return; }
      doc = parsed.doc;
    } else {
      doc = JSON.parse(JSON.stringify(text));
    }
    const structural = validateDocument(doc, shown);
    this.issues.push(...structural);
    const order = pointerOrder(doc);
    if (isObject(doc)) {
      const ext = doc['extends'];
      const list = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
      list.forEach((entry, i) => {
        if (typeof entry !== 'string' || !entry) return;
        const pointer = typeof ext === 'string' ? '/extends' : `/extends/${i}`;
        let target: string;
        if (entry.startsWith(PRESET_PREFIX)) {
          if (this.presets[entry.slice(PRESET_PREFIX.length)] === undefined) {
            const known = Object.keys(this.presets);
            this.issues.push({ file: shown, pointer, message: `unknown preset ${quote(entry)}${known.length ? `; available: ${known.map((k) => PRESET_PREFIX + k).join(', ')}` : '; no presets are installed'}` });
            return;
          }
          target = entry;
        } else if (file.startsWith(PRESET_PREFIX)) {
          this.issues.push({ file: shown, pointer, message: 'a preset can extend only other presets' });
          return;
        } else {
          target = resolve(dirname(file), entry);
          // ELOOP, EACCES and ENOTDIR throw even with throwIfNoEntry: each is a problem at this entry.
          let stat;
          try {
            stat = statSync(target, { throwIfNoEntry: false });
          } catch (err) {
            this.issues.push({ file: shown, pointer, message: `extended path ${quote(entry)} cannot be read: ${fsReason(err)} (${this.display(target)})` });
            return;
          }
          if (!stat) {
            this.issues.push({ file: shown, pointer, message: `extended file ${quote(entry)} not found (${this.display(target)})` });
            return;
          }
          if (stat.isDirectory()) {
            this.issues.push({ file: shown, pointer, message: `extended path ${quote(entry)} is a directory, not a file (${this.display(target)})` });
            return;
          }
        }
        const cycleAt = stack.indexOf(target);
        if (cycleAt >= 0 || target === file) {
          const cycle = [...stack.slice(cycleAt >= 0 ? cycleAt : stack.length), file, target].map((f) => this.display(f));
          this.issues.push({ file: shown, pointer, message: `circular extends: ${cycle.join(' → ')}` });
          return;
        }
        this.load(target, [...stack, file]);
      });
    }
    this.done.add(file);
    if (isObject(doc)) this.docs.push({ file: shown, doc: doc as ArchitectureDocument, order });
  }
}

// ─── Merging and semantic validation ─────────────────────────────────────────────────────────

interface Origin { file: string; pointer: string }
interface MergedLayer { layer: Layer; origin: Origin }
interface MergedAllowance { allowance: Allowance; origin: Origin }

/**
 * Loads and validates the configuration of the workspace at `dir`. Null when it has none (no
 * `.mapx/architecture.jsonc`, or no such view); throws ConfigError listing every problem.
 */
export function loadArchitectureConfig(dir: string, options: LoadOptions = {}): ArchitectureConfig | null {
  const { config, issues } = loadWithIssues(dir, options);
  if (issues.length) throw new ConfigError(issues);
  return config;
}

function loadWithIssues(dir: string, options: LoadOptions): { config: ArchitectureConfig | null; files: string[]; issues: ConfigIssue[] } {
  const workspace = resolve(dir);
  const outside = options.view !== undefined ? viewProblem(workspace, options.view) : null;
  if (outside) return { config: null, files: [], issues: [outside] };
  const path = architectureConfigPath(workspace, options.view);
  const loader = new Loader(workspace, options.presets ?? PRESETS);
  // Only "no such file" means no configuration; any other error is a problem with it.
  try {
    if (!statSync(path, { throwIfNoEntry: false })) return { config: null, files: [], issues: [] };
  } catch (err) {
    return { config: null, files: [], issues: [{ file: loader.display(path), pointer: '', message: `cannot be read: ${fsReason(err)}` }] };
  }
  loader.load(path, []);
  const { config, issues } = mergeAndValidate(loader.docs, options.view ?? null);
  return { config, files: loader.docs.map((d) => d.file), issues: sortIssues([...loader.issues, ...issues], loader.docs) };
}

/** What `mapx arch validate-config` and `mapx_arch_validate_config` report (M5-02-R1). */
export interface ValidationReport {
  valid: boolean;
  view: string | null;
  /** The documents read, in load order (extended documents first). */
  files: string[];
  /** Every problem, in document order; a missing configuration is one `not found` issue. */
  issues: ConfigIssue[];
}

/** Validates the configuration of the workspace at `dir` (or a view); needs no index. */
export function validateArchitectureConfig(dir: string, options: LoadOptions = {}): { report: ValidationReport; config: ArchitectureConfig | null } {
  const view = options.view ?? null;
  const { config, files, issues } = loadWithIssues(dir, options);
  if (!config && !issues.length) {
    const file = view ? `.mapx/architecture/${view}.jsonc` : '.mapx/architecture.jsonc';
    issues.push({ file, pointer: '', message: view ? `not found: no view ${quote(view)}` : 'not found: create it (see docs/architecture-rules.md)' });
  }
  return { report: { valid: issues.length === 0, view, files, issues }, config: issues.length ? null : config };
}

/** The text form: one `file#pointer: message` line per problem and a count, or a one-line verdict. */
export function formatValidation(report: ValidationReport, config?: Pick<ArchitectureConfig, 'layers'>): string {
  if (report.valid) return `Valid: ${report.files.join(', ')}${config ? ` (${config.layers.length} layer${config.layers.length === 1 ? '' : 's'})` : ''}.`;
  const lines = report.issues.map((i) => `${i.file}${i.pointer ? `#${i.pointer}` : ''}: ${i.message}`);
  const files = [...new Set(report.issues.map((i) => i.file))];
  lines.push(`${report.issues.length} problem${report.issues.length === 1 ? '' : 's'} in ${files.join(', ')}.`);
  return lines.join('\n');
}

/** Validates one document as a whole configuration (no `extends` resolution): the issues, or none. */
export function validateArchitectureText(text: string, file = 'architecture.jsonc'): ConfigIssue[] {
  const parsed = parseArchitectureText(text, file);
  if (parsed.issues.length) return parsed.issues;
  const structural = validateDocument(parsed.doc, file);
  if (!isObject(parsed.doc)) return structural;
  const docs: LoadedDoc[] = [{ file, doc: parsed.doc as ArchitectureDocument, order: pointerOrder(parsed.doc) }];
  return sortIssues([...structural, ...mergeAndValidate(docs, null).issues], docs);
}

function sortIssues(issues: ConfigIssue[], docs: LoadedDoc[]): ConfigIssue[] {
  const fileIndex = new Map(docs.map((d, i) => [d.file, i]));
  const orderOf = (issue: ConfigIssue) => {
    const order = docs.find((d) => d.file === issue.file)?.order;
    if (!order) return Number.MAX_SAFE_INTEGER;
    let pointer = issue.pointer;
    for (;;) {
      const n = order.get(pointer);
      if (n !== undefined) return n;
      if (!pointer) return Number.MAX_SAFE_INTEGER;
      pointer = pointer.slice(0, pointer.lastIndexOf('/'));
    }
  };
  const seen = new Set<string>();
  return issues
    .map((issue, i) => ({ issue, i, f: fileIndex.get(issue.file) ?? -1, o: orderOf(issue) }))
    .sort((a, b) => a.f - b.f || a.o - b.o || a.i - b.i)
    .map((x) => x.issue)
    .filter((i) => { const k = `${i.file}#${i.pointer}#${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function mergeAndValidate(docs: LoadedDoc[], view: string | null): { config: ArchitectureConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const issue = (origin: Origin, message: string) => issues.push({ file: origin.file, pointer: origin.pointer, message });

  const declared: Record<string, string> = {};
  const parameterOrigins: Record<string, Origin> = {};
  const scope: ArchitectureConfig['scope'] = { types: [...DEFAULT_SCOPE_TYPES], include: [], exclude: [] };
  const policy: ArchitectureConfig['policy'] = { ...DEFAULTS.policy, uncovered: { ...DEFAULTS.policy.uncovered } };
  const visibility: ArchitectureConfig['visibility'] = { ...DEFAULTS.visibility, internalTags: [...DEFAULTS.visibility.internalTags] };
  const report: ArchitectureConfig['report'] = { groups: {}, hidden: [], pointToGroups: false, codeclimate: {} };
  let baseline: string | null = null;
  const layers: MergedLayer[] = [];
  const rules = new Map<string, { origin: Origin; list: MergedAllowance[] }>();

  for (const { file, doc } of docs) {
    if (isObject(doc.parameters)) {
      for (const [k, v] of Object.entries(doc.parameters)) {
        if (typeof v !== 'string') continue;
        declared[k] = v;
        parameterOrigins[k] = { file, pointer: at('/parameters', k) };
      }
    }
    if (isObject(doc.scope)) {
      if (Array.isArray(doc.scope.types)) scope.types = doc.scope.types.filter((t) => EDGE_TYPES.includes(t));
      if (Array.isArray(doc.scope.include)) scope.include = doc.scope.include.filter((s) => typeof s === 'string');
      if (Array.isArray(doc.scope.exclude)) scope.exclude = doc.scope.exclude.filter((s) => typeof s === 'string');
    }
    if (isObject(doc.policy)) {
      const p = doc.policy;
      if (['error', 'warn', 'ignore'].includes(p.inferred as string)) policy.inferred = p.inferred!;
      if (typeof p.inheritDependencies === 'boolean') policy.inheritDependencies = p.inheritDependencies;
      if (typeof p.strictLayers === 'boolean') policy.strictLayers = p.strictLayers;
      if (isObject(p.uncovered)) {
        if (typeof p.uncovered.externals === 'boolean') policy.uncovered.externals = p.uncovered.externals;
        if (typeof p.uncovered.builtins === 'boolean') policy.uncovered.builtins = p.uncovered.builtins;
      }
    }
    if (isObject(doc.visibility)) {
      if (Array.isArray(doc.visibility.internalTags)) visibility.internalTags = doc.visibility.internalTags.filter((s) => typeof s === 'string');
      if (typeof doc.visibility.nativeMarkers === 'boolean') visibility.nativeMarkers = doc.visibility.nativeMarkers;
    }
    // A view has its own baseline (.mapx/architecture/<view>.baseline.json) unless the view document
    // itself names one: a view extending the main configuration must not read or overwrite the
    // main baseline (review of M5-06).
    if (typeof doc.baseline === 'string' && (view === null || doc === docs[docs.length - 1]!.doc)) baseline = doc.baseline;
    if (isObject(doc.report)) {
      if (isObject(doc.report.groups)) for (const [g, ls] of Object.entries(doc.report.groups)) if (Array.isArray(ls)) report.groups[g] = ls.filter((s) => typeof s === 'string');
      if (typeof doc.report.pointToGroups === 'boolean') report.pointToGroups = doc.report.pointToGroups;
      if (Array.isArray(doc.report.hidden)) report.hidden = [...new Set([...report.hidden, ...doc.report.hidden.filter((s) => typeof s === 'string')])];
      if (isObject(doc.report.codeclimate)) {
        for (const k of CODECLIMATE_KEYS) {
          const v = doc.report.codeclimate[k];
          if (CODECLIMATE_SEVERITIES.includes(v as never)) report.codeclimate[k] = v;
        }
      }
    }
    if (Array.isArray(doc.layers)) {
      const namesHere = new Set<string>();
      doc.layers.forEach((layer, i) => {
        if (!isObject(layer) || typeof layer.name !== 'string' || !layer.name) return;
        const origin = { file, pointer: `/layers/${i}` };
        if (namesHere.has(layer.name)) {
          issue({ file, pointer: `/layers/${i}/name` }, `duplicate layer ${quote(layer.name)}; a layer name is declared once per document`);
          return;
        }
        namesHere.add(layer.name);
        const copy = JSON.parse(JSON.stringify(layer)) as Layer;
        if (!Array.isArray(copy.selectors)) copy.selectors = [];
        const existing = layers.findIndex((l) => l.layer.name === layer.name);
        // A later document overrides a layer by name, in the position the layer first had.
        if (existing >= 0) layers[existing] = { layer: copy, origin };
        else layers.push({ layer: copy, origin });
      });
    }
    if (isObject(doc.rules)) {
      for (const [source, list] of Object.entries(doc.rules)) {
        if (!Array.isArray(list)) continue;
        const origin = { file, pointer: at('/rules', source) };
        const entry = rules.get(source) ?? { origin, list: [] };
        list.forEach((allowance, i) => {
          if (typeof allowance !== 'string' && !isObject(allowance)) return;
          const key = JSON.stringify(allowance);
          if (entry.list.some((m) => JSON.stringify(m.allowance) === key)) return;
          entry.list.push({ allowance: allowance as Allowance, origin: { file, pointer: at('/rules', source, i) } });
        });
        rules.set(source, entry);
      }
    }
  }

  const names = new Set(layers.map((l) => l.layer.name));
  const overlays = new Set(layers.filter((l) => l.layer.overlay === true).map((l) => l.layer.name));

  const parameters = resolveParameters(declared, parameterOrigins, issue);

  // Layers: parameters, regexes, `layer` selectors.
  const layerRefs = new Map<string, Array<{ to: string; origin: Origin }>>();
  for (const { layer, origin } of layers) {
    const visit = (sel: unknown, pointer: string) => {
      if (!isObject(sel)) return;
      // Every string value (M5-02-R1). In name, path and package an undefined parameter is an error,
      // as before; in the other keys it stays literal text, so `"value": "%s%s"` keeps loading.
      for (const [key, raw] of Object.entries(sel)) {
        if (typeof raw !== 'string') continue;
        const { value, missing } = substitute(raw, parameters);
        if (STRICT_PARAMETER_KEYS.has(key)) for (const m of missing) issue({ file: origin.file, pointer: at(pointer, key) }, `parameter %${m}% has no value; declare it in "parameters"`);
        // A framework part given by a parameter is checked once substituted (validateSelector skips it).
        if (key === 'framework' && PARAMETER_REF.test(raw) && !FRAMEWORK_PARTS.includes(value as never)) issue({ file: origin.file, pointer: at(pointer, key) }, unknownFramework(value));
        sel[key] = value;
      }
      for (const key of ['name', 'member', 'value'] as const) {
        if (typeof sel[key] === 'string') {
          const problem = regexProblem(sel[key] as string);
          if (problem) issue({ file: origin.file, pointer: at(pointer, key) }, problem);
        }
      }
      // `path`, `decorator` (M5-10) and the ancestor values (M5-09) are regexes only when written `/…/flags`.
      for (const key of ['path', 'decorator', 'extends', 'implements', 'inherits', 'mixes'] as const) {
        if (typeof sel[key] === 'string' && /^\/.*\/[a-z]*$/.test(sel[key] as string)) {
          const problem = regexProblem(sel[key] as string);
          if (problem) issue({ file: origin.file, pointer: at(pointer, key) }, problem);
        }
      }
      if (typeof sel['layer'] === 'string') {
        const target = sel['layer'] as string;
        if (!names.has(target)) issue({ file: origin.file, pointer: at(pointer, 'layer') }, `unknown layer ${quote(target)}${suggest(target, names)}`);
        else {
          const refs = layerRefs.get(layer.name) ?? [];
          refs.push({ to: target, origin: { file: origin.file, pointer: at(pointer, 'layer') } });
          layerRefs.set(layer.name, refs);
        }
      }
      if (Array.isArray(sel['all'])) (sel['all'] as unknown[]).forEach((s, i) => visit(s, at(pointer, 'all', i)));
      if (Array.isArray(sel['any'])) (sel['any'] as unknown[]).forEach((s, i) => visit(s, at(pointer, 'any', i)));
      if (sel['not'] !== undefined) visit(sel['not'], at(pointer, 'not'));
    };
    layer.selectors.forEach((s, i) => visit(s, at(origin.pointer, 'selectors', i)));
    if (Array.isArray(layer.private)) layer.private.forEach((s, i) => visit(s, at(origin.pointer, 'private', i)));
  }
  for (const cycle of findCycles(layerRefs)) {
    issue(cycle.origin, `layer selectors form a cycle: ${cycle.path.join(' → ')}`);
  }

  // Rules: sources, targets, overlays, `+` cycles.
  const plusRefs = new Map<string, Array<{ to: string; origin: Origin }>>();
  for (const [source, { origin, list }] of rules) {
    if (source !== '*') {
      if (!names.has(source)) issue(origin, `rules for unknown layer ${quote(source)}${suggest(source, names)}`);
      else if (overlays.has(source)) issue(origin, `${quote(source)} is an overlay layer: it is only ever a rule target, so it has no rules`);
    }
    for (const { allowance, origin: ao } of list) {
      const targets: Array<{ value: string; pointer: string }> = typeof allowance === 'string'
        ? [{ value: allowance, pointer: ao.pointer }]
        : [
          ...(Array.isArray(allowance.allow) ? allowance.allow.map((v, i) => ({ value: v, pointer: at(ao.pointer, 'allow', i) })) : []),
          ...(typeof allowance.to === 'string' ? [{ value: allowance.to, pointer: at(ao.pointer, 'to') }] : []),
        ];
      for (const { value, pointer } of targets) {
        if (typeof value !== 'string') continue;
        const m = ALLOWANCE_STRING.exec(value);
        if (!m || m[2] === '*') continue;
        const target = m[2]!;
        const where = { file: ao.file, pointer };
        if (!names.has(target)) { issue(where, `unknown layer ${quote(target)}${suggest(target, names)}`); continue; }
        if (m[1] === '+') {
          if (overlays.has(target)) issue(where, `${quote(value)}: ${quote(target)} is an overlay layer and has no allowances to inherit`);
          else if (source === '*') issue(where, `${quote(value)}: "+" inherits a layer's allowances and cannot be a default for every layer`);
          else {
            const refs = plusRefs.get(source) ?? [];
            refs.push({ to: target, origin: where });
            plusRefs.set(source, refs);
          }
        }
      }
    }
  }
  for (const cycle of findCycles(plusRefs)) {
    issue(cycle.origin, `"+" allowances form a cycle: ${cycle.path.join(' → ')}`);
  }

  // Report and policy references to layers.
  const lastDoc = docs[docs.length - 1];
  const reportOrigin = (pointer: string): Origin => {
    for (let i = docs.length - 1; i >= 0; i--) if (docs[i]!.order.has(pointer)) return { file: docs[i]!.file, pointer };
    return { file: lastDoc?.file ?? '', pointer };
  };
  for (const [group, ls] of Object.entries(report.groups)) {
    ls.forEach((l, i) => { if (!names.has(l)) issue(reportOrigin(at('/report/groups', group, i)), `unknown layer ${quote(l)}${suggest(l, names)}`); });
  }
  report.hidden.forEach((l, i) => { if (!names.has(l)) issue(reportOrigin(at('/report/hidden', i)), `unknown layer ${quote(l)}${suggest(l, names)}`); });

  const config: ArchitectureConfig = {
    files: docs.map((d) => d.file),
    view,
    parameters,
    scope,
    policy,
    visibility,
    layers: layers.map((l) => l.layer),
    rules: Object.fromEntries([...rules].map(([k, v]) => [k, v.list.map((m) => m.allowance)])),
    baseline,
    report,
  };
  return { config, issues };
}

/** `%%` (a literal `%`) or a `%name%` reference. */
const PARAMETER = /%%|%([A-Za-z_][\w.-]*)%/g;
const PARAMETER_REF = /%[A-Za-z_][\w.-]*%/;
/** Selector keys in which an undefined parameter is an error (M5-02); elsewhere it is literal text. */
const STRICT_PARAMETER_KEYS = new Set(['name', 'path', 'package']);

/** `%name%` replaced from `parameters` and `%%` by `%`; `missing` lists names without a value (kept as written). */
function substitute(value: string, parameters: Record<string, string>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(PARAMETER, (whole, name: string | undefined) => {
    if (name === undefined) return '%';
    if (name in parameters) return parameters[name]!;
    missing.push(name);
    return whole;
  });
  return { value: out, missing };
}

/**
 * Parameter values with the parameters they name resolved (`"root": "%base%/app"`). An undefined
 * reference, or a cycle (named once: `%a% → %b% → %a%`), is an error at the parameter.
 */
function resolveParameters(declared: Record<string, string>, origins: Record<string, Origin>, issue: (origin: Origin, message: string) => void): Record<string, string> {
  const resolved: Record<string, string> = {};
  const stack: string[] = [];
  const cycles = new Set<string>();
  const resolveOne = (name: string): string => {
    if (name in resolved) return resolved[name]!;
    stack.push(name);
    const value = declared[name]!.replace(PARAMETER, (whole, ref: string | undefined) => {
      if (ref === undefined) return '%';
      if (!(ref in declared)) {
        issue(origins[name]!, `parameter %${ref}% has no value; declare it in "parameters"`);
        return whole;
      }
      const at = stack.indexOf(ref);
      if (at < 0) return resolveOne(ref);
      const chain = [...stack.slice(at), ref];
      const key = [...new Set(chain)].sort().join('\u0000');
      if (!cycles.has(key)) {
        cycles.add(key);
        issue(origins[chain[0]!]!, `parameters form a cycle: ${chain.map((n) => `%${n}%`).join(' → ')}`);
      }
      return whole;
    });
    stack.pop();
    resolved[name] = value;
    return value;
  };
  for (const name of Object.keys(declared)) resolveOne(name);
  return resolved;
}

/** Why a selector regex does not compile (`/body/flags` or a bare body), or null. */
function regexProblem(source: string): string | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(source);
  try {
    new RegExp(m ? m[1]! : source, m ? m[2] : 'i');
    return null;
  } catch (err) {
    return `not a valid regular expression: ${err instanceof Error ? err.message : err}`;
  }
}

/** Each cycle once, from its first edge in declaration order, as `A → B → A`. */
function findCycles(graph: Map<string, Array<{ to: string; origin: Origin }>>): Array<{ path: string[]; origin: Origin }> {
  const cycles: Array<{ path: string[]; origin: Origin }> = [];
  const reported = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: Array<{ node: string; origin?: Origin }> = [];
  const visit = (node: string) => {
    state.set(node, 'visiting');
    for (const edge of graph.get(node) ?? []) {
      stack.push({ node, origin: edge.origin });
      if (state.get(edge.to) === 'visiting') {
        const start = stack.findIndex((s) => s.node === edge.to);
        const loop = stack.slice(start);
        const members = loop.map((s) => s.node);
        const key = [...members].sort().join('\u0000');
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push({ path: [...members, edge.to], origin: loop[0]!.origin! });
        }
      } else if (!state.has(edge.to)) {
        visit(edge.to);
      }
      stack.pop();
    }
    state.set(node, 'done');
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

/** "; did you mean X?" for a close layer name (case, one edit), or nothing. */
function suggest(name: string, names: Set<string>): string {
  const lower = name.toLowerCase();
  for (const n of names) if (n.toLowerCase() === lower) return `; did you mean ${quote(n)}?`;
  for (const n of names) if (editDistanceAtMostOne(n.toLowerCase(), lower)) return `; did you mean ${quote(n)}?`;
  return '';
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
