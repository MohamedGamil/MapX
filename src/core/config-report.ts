// The effective configuration as the dashboard shows it (M4-22, D027 read-only): every known
// setting with its value and where the value comes from, the repos and user languages, and
// validation warnings. Nothing here writes the configuration.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Config } from './config.js';
import { DEFAULT_CONFIG, JS_INIT_EXCLUDES, LARAVEL_DEFAULT_EXCLUDES, PHP_INIT_EXCLUDES } from './config.js';
import { getBuiltinLanguages } from '../languages/registry.js';

/** default: MapX's built-in value (setting absent, or equal to the default); user: set in config.json; env: an environment variable overrides it. */
export type SettingSource = 'default' | 'user' | 'env';

export interface SettingReport {
  key: string;
  description: string;
  value: unknown;
  source: SettingSource;
  default: unknown;
  /** For pattern lists: each entry and whether MapX or the user put it there. */
  entries?: Array<{ value: string; source: 'default' | 'user' }>;
}

export interface ConfigReport {
  path: string;
  settings: SettingReport[];
  repos: Array<{ name: string; path: string; framework?: string; exists: boolean; primary: boolean }>;
  languages: Array<{ name: string; extensions: string[]; grammarWasm: string; queries: string[] }>;
  warnings: string[];
}

const DEFAULTS = DEFAULT_CONFIG.settings;
/** Every pattern MapX itself may write into an exclude list (defaults, init's language extras, Laravel's). */
const BUILT_IN_EXCLUDES = new Set([...DEFAULTS.excludePatterns, ...PHP_INIT_EXCLUDES, ...JS_INIT_EXCLUDES, ...LARAVEL_DEFAULT_EXCLUDES]);

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Known {
  description: string;
  default: unknown;
  /** A warning when the value is invalid, else null. */
  check(value: unknown): string | null;
  /** Built-in entries of a pattern list. */
  builtIn?: Set<string>;
}

const KNOWN: Record<string, Known> = {
  maxTokenBudget: {
    description: 'Token budget of exports and context builds',
    default: DEFAULTS.maxTokenBudget,
    check: (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? null : 'expected a whole number above 0'),
  },
  excludePatterns: {
    description: 'Files never indexed (globs)',
    default: DEFAULTS.excludePatterns,
    check: (v) => (isStringList(v) ? null : 'expected a list of glob strings'),
    builtIn: BUILT_IN_EXCLUDES,
  },
  includePatterns: {
    description: 'Files indexed even when an exclude matches (globs)',
    default: DEFAULTS.includePatterns,
    check: (v) => (isStringList(v) ? null : 'expected a list of glob strings'),
    builtIn: new Set(DEFAULTS.includePatterns),
  },
  graphExcludePatterns: {
    description: 'Indexed files left out of graph analysis: clusters, metrics, smells (globs)',
    default: DEFAULTS.graphExcludePatterns,
    check: (v) => (isStringList(v) ? null : 'expected a list of glob strings'),
    builtIn: new Set(DEFAULTS.graphExcludePatterns),
  },
  laravelDefaultExcludes: {
    description: "Laravel's default excludes for repos with framework laravel: true, false, or the patterns to apply",
    default: true,
    check: (v) => (typeof v === 'boolean' || isStringList(v) ? null : 'expected true, false or a list of patterns'),
  },
  parseWorkers: {
    description: 'Parse workers per batch: "auto", a number, or 0 for the main thread',
    default: 'auto',
    check: (v) => (v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v)) ? null : 'expected "auto" or a whole number ≥ 0; "auto" is used'),
  },
  php: {
    description: 'PHP options: facadeMap maps facade aliases to their classes',
    default: {},
    check: (v) => {
      if (!isPlainObject(v)) return 'expected an object';
      const unknown = Object.keys(v).filter((k) => k !== 'facadeMap');
      if (unknown.length) return `unknown key ${unknown.map((k) => JSON.stringify(k)).join(', ')}`;
      const map = v['facadeMap'];
      if (map !== undefined && !(isPlainObject(map) && Object.values(map).every((x) => typeof x === 'string'))) return 'facadeMap: expected an object of alias → class names';
      return null;
    },
  },
  http: {
    description: 'HTTP clients MapX cannot recognise on its own, and the hosts of the workspace\'s backends',
    default: {},
    check: (v) => {
      if (!isPlainObject(v)) return 'expected an object';
      const unknown = Object.keys(v).filter((k) => k !== 'clients' && k !== 'hosts');
      if (unknown.length) return `unknown key ${unknown.map((k) => JSON.stringify(k)).join(', ')}`;
      const clients = v['clients'];
      if (clients !== undefined && !(Array.isArray(clients) && clients.every((c) => isPlainObject(c) && typeof c['receiver'] === 'string' && (c['baseURL'] === undefined || typeof c['baseURL'] === 'string')))) {
        return 'clients: expected a list of { receiver, baseURL? }';
      }
      if (v['hosts'] !== undefined && !isStringList(v['hosts'])) return 'hosts: expected a list of host names';
      return null;
    },
  },
  architecture: {
    description: 'Architecture role rules for file classification',
    default: {},
    check: (v) => (isPlainObject(v) ? null : 'expected an object'),
  },
};

/** The effective configuration of the workspace at `dir`, with sources and warnings. */
export function describeConfig(dir: string, config: Config, env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const settings = config.settings as Record<string, unknown>;
  const warnings: string[] = [];
  const reports: SettingReport[] = [];

  for (const [key, known] of Object.entries(KNOWN)) {
    const present = Object.prototype.hasOwnProperty.call(settings, key);
    const value = present ? settings[key] : known.default;
    let source: SettingSource = present && !same(value, known.default) ? 'user' : 'default';
    if (present) {
      const problem = known.check(value);
      if (problem) warnings.push(`settings.${key}: ${problem} (found ${JSON.stringify(value)})`);
    }
    if (key === 'parseWorkers' && env['MAPX_PARSE_WORKERS']) {
      source = 'env';
      const envValue = env['MAPX_PARSE_WORKERS'];
      if (known.check(envValue)) warnings.push(`MAPX_PARSE_WORKERS: expected "auto" or a whole number ≥ 0 (found ${JSON.stringify(envValue)})`);
      reports.push({ key, description: `${known.description}. Set by MAPX_PARSE_WORKERS`, value: envValue, source, default: known.default });
      continue;
    }
    const report: SettingReport = { key, description: known.description, value, source, default: known.default };
    if (known.builtIn && isStringList(value)) {
      report.entries = value.map((pattern) => ({ value: pattern, source: known.builtIn!.has(pattern) ? 'default' : 'user' }));
      if (report.entries.some((e) => e.source === 'user')) report.source = 'user';
    }
    reports.push(report);
  }

  for (const key of Object.keys(settings)) {
    if (!(key in KNOWN)) warnings.push(`settings.${key}: unknown setting; MapX ignores it`);
  }

  const workspaceRoot = resolve(dir);
  const repos = config.repos.map((r, i) => ({
    name: r.name,
    path: r.path,
    ...(r.framework ? { framework: r.framework } : {}),
    exists: existsSync(resolve(workspaceRoot, r.path)),
    primary: i === 0,
  }));
  for (const r of repos) if (!r.exists) warnings.push(`repos: "${r.name}" points to ${r.path}, which does not exist`);
  for (const c of config.collapsedRepos ?? []) warnings.push(`repos: "${c.dropped.name}" names the same folder as "${c.kept.name}" and is ignored`);

  const builtIns = new Set(Object.keys(getBuiltinLanguages()));
  const languages = Object.entries(config.languages ?? {}).map(([name, def]) => ({
    name,
    extensions: Array.isArray(def?.extensions) ? def.extensions : [],
    grammarWasm: typeof def?.grammarWasm === 'string' ? def.grammarWasm : '',
    queries: Object.keys(def?.queries ?? {}),
  }));
  for (const l of languages) {
    if (!l.extensions.length) warnings.push(`languages.${l.name}: no file extensions`);
    if (!l.grammarWasm) warnings.push(`languages.${l.name}: no grammarWasm`);
    else if (isAbsolute(l.grammarWasm) && !existsSync(l.grammarWasm)) warnings.push(`languages.${l.name}: grammar ${l.grammarWasm} not found`);
    if (builtIns.has(l.name)) warnings.push(`languages.${l.name}: has the name of a built-in language; MapX ignores this definition`);
  }

  return { path: resolve(workspaceRoot, '.mapx', 'config.json'), settings: reports, repos, languages, warnings };
}
