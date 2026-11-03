// `mapx arch init` and `mapx_arch_init` (M5-17; docs/research/deptrac AR-15): a starting
// configuration a person reviews, inferred from the index or taken from a shipped preset, with the
// observed layer graph in its comments and, on request, a baseline of today's violations so that
// day one is green. The CLI (src/cli.ts) and the MCP tool (src/arch/mcp-tools.ts) both call
// `runInit`, so they propose and write the same bytes.
//
// Sources:
//   roles      one layer per MapX role in the archetype's LAYER_ORDER, "may depend downward" (M5-14)
//   clusters   one layer per primary cluster; the rules allow the cluster graph the index has today
//   framework  the preset of the framework the codebase profile detected (laravel, nestjs, django)
//   preset     a document extending mapx:preset/<id>, its path parameters inferred from the index
// Every proposal is loaded through config.ts (presets resolved) and evaluated with buildReport, so
// its issues and counts are what `mapx arch validate-config` and `mapx check` would report.
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import picomatch from 'picomatch';
import type { Store } from '../core/store.js';
import { LAYER_ORDER } from '../core/flow-validator.js';
import type { CodebaseArchetype, FileRole } from '../types.js';
import { architectureConfigPath, loadArchitectureText, parseArchitectureText, PRESET_PREFIX, PRESETS, viewProblem, type ConfigIssue } from './config.js';
import type { ArchitectureDocument, Layer } from './schema.js';
import { getMembership } from './membership.js';
import { buildReport, type ArchReport } from './report.js';
import { defaultBaselinePath, renderBaseline } from './baseline.js';

export const INIT_SOURCES = ['roles', 'clusters', 'framework'] as const;
export type InitSource = typeof INIT_SOURCES[number];

/** The preset of each framework a detector names (src/frameworks/detectors), in the order tried. */
export const FRAMEWORK_PRESETS: Readonly<Record<string, string>> = { laravel: 'laravel', nestjs: 'nestjs', django: 'django' };

export interface InitOptions {
  /** Where layers come from (default roles); `framework` picks the preset of the detected framework. */
  from?: InitSource;
  /** A shipped preset id (`mapx:preset/<id>`); excludes `from`. */
  preset?: string;
  /** Also propose a baseline of the proposal's violations on today's index (AR-10). */
  baseline?: boolean;
  /** A view: `.mapx/architecture/<view>.jsonc`. */
  view?: string;
  /** Repo name → its path in the workspace (fingerprints name repos by path, as `mapx check` does). */
  repoPaths?: Record<string, string>;
  /** The repos whose codebase profiles give the archetype (the first) and detected frameworks (all). */
  repos?: string[];
}

export interface ProposedLayer { name: string; files: number; role?: string; cluster?: string; path?: string }
export interface ObservedPair { from: string; to: string; dependencies: number; violations: number }

export interface Proposal {
  source: 'roles' | 'clusters' | 'preset';
  /** The preset extended (`preset` and `framework` sources), else null. */
  preset: string | null;
  /** The archetype of the first repo's codebase profile (`mixed` without one). */
  archetype: CodebaseArchetype;
  /** Parameters this document sets (a preset's inferred path parameters). */
  parameters: Record<string, string>;
  /** Every layer of the loaded configuration, in order, with the files it holds on this index. */
  layers: ProposedLayer[];
  /** Roles the index assigns that the archetype's order does not place (roles source). */
  unplaced: Array<{ role: string; files: number }>;
  /** The observed layer graph: dependencies per layer pair, and how many break the proposed rules. */
  observed: ObservedPair[];
  /** Violations the proposal reports on today's index (what a baseline would list). */
  violations: number;
  /** The configuration as JSONC. */
  text: string;
  /** The baseline of those violations (`renderBaseline`), when asked for. */
  baseline: { text: string; entries: number } | null;
  /** What `mapx arch validate-config` would report for it: none, unless nothing could be proposed. */
  issues: ConfigIssue[];
  /** Remarks for the person reviewing it (also in the JSONC header). */
  notes: string[];
}

/** A request `mapx arch init` refuses: exit 3 (AR-17), with what to add to a JSON answer. */
export class InitError extends Error {
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'InitError';
  }
}

/** Why the options cannot be used together, or null. */
export function initOptionsProblem(options: { from?: string; preset?: string; view?: string }): string | null {
  if (options.from !== undefined && !(INIT_SOURCES as readonly string[]).includes(options.from)) return `from must be one of ${INIT_SOURCES.join(', ')}, not "${options.from}"`;
  if (options.preset !== undefined) {
    if (options.from !== undefined) return 'give a preset or a source (from), not both';
    if (!(options.preset in PRESETS)) return `unknown preset "${options.preset}"; available: ${Object.keys(PRESETS).sort().join(', ')}`;
  }
  if (options.view !== undefined && (!options.view.trim() || /[\\/]|^\.\.?$/.test(options.view))) return `view "${options.view}" is not a file name in .mapx/architecture/`;
  return null;
}

// ─── Inference ───────────────────────────────────────────────────────────────────────────────

const layerName = (raw: string) => raw.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Root';
/** A comment line never ends early or breaks the JSONC: control characters become spaces. */
const commentText = (s: string) => s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Files that hold code a layer is about; data and docs (package.json, README.md) do not decide a layout. */
const DATA_LANGUAGES = new Set(['json', 'jsonc', 'yaml', 'toml', 'xml', 'markdown', 'text', 'ini', 'csv']);

/** One JSON value on one line, with spaces: `{ "name": "Http", "selectors": [{ "path": "app/Http/**" }] }`. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

/**
 * `text` (a folder name) as a parameter value that matches only itself in a path glob: picomatch's
 * metacharacters escaped with `\`, and `%` doubled, which config.ts reads back as `%`.
 */
export function globLiteral(text: string): string {
  return text.replace(/[\\*?[\]{}()!+@|]/g, '\\$&').replace(/%/g, '%%');
}
/** The folder name a `globLiteral` value stands for. */
const globText = (glob: string) => glob.replace(/%%/g, '%').replace(/\\(.)/g, '$1');

interface Draft {
  header: string[];
  extends?: string;
  parameters?: Record<string, string>;
  layers?: Array<{ comment: string[]; layer: Layer }>;
  rules?: Array<{ source: string; list: string[] }>;
}

/** The document as JSONC: the header, then one line per layer and rule, each after its comments. */
function renderDraft(d: Draft, ruleComment: (source: string) => string[] = () => []): string {
  const sections: string[] = [];
  if (d.extends !== undefined) sections.push(`  "extends": ${JSON.stringify(d.extends)}`);
  if (d.parameters && Object.keys(d.parameters).length) sections.push(`  "parameters": ${inline(d.parameters)}`);
  const comments = (lines: string[]) => lines.map((l) => `    // ${commentText(l)}\n`).join('');
  if (d.layers) {
    const items = d.layers.map((l) => `${comments(l.comment)}    ${inline(l.layer)}`);
    sections.push(items.length ? `  "layers": [\n${items.join(',\n')}\n  ]` : '  "layers": []');
  }
  if (d.rules) {
    const items = d.rules.map((r) => `${comments(ruleComment(r.source))}    ${JSON.stringify(r.source)}: ${inline(r.list)}`);
    sections.push(items.length ? `  "rules": {\n${items.join(',\n')}\n  }` : '  "rules": {}');
  }
  return `${d.header.map((l) => `// ${commentText(l)}`).join('\n')}\n{\n${sections.join(',\n')}\n}\n`;
}

/** The document a draft stands for, without comments (what is loaded and evaluated). */
function draftText(d: Draft): string {
  return renderDraft({ ...d, header: [] }).replace(/^\n/, '');
}

interface Evaluated { report: ArchReport | null; issues: ConfigIssue[] }

/** Loads `text` as the workspace's configuration (presets resolved) and evaluates it on the index. */
function evaluate(store: Store, workspace: string, text: string, options: InitOptions): Evaluated {
  const { config, issues } = loadArchitectureText(workspace, text, { view: options.view });
  if (!config) return { report: null, issues };
  const membership = getMembership(store, workspace, config, join(workspace, '.mapx', 'mapx.db'), options.repoPaths);
  return { report: buildReport(store, config, membership, { repoPaths: options.repoPaths }), issues: [] };
}

/** Dependencies per layer pair (the report's layer matrix), in its order. */
function observedOf(report: ArchReport | null): ObservedPair[] {
  return (report?.layerEdges ?? []).map((e) => ({ from: e.from, to: e.to, dependencies: e.allowed + e.violations + e.skipped, violations: e.violations }));
}

/** `Data 3, Shared 1` for the pairs out of `layer`, and those against the rules. */
function outgoing(observed: ObservedPair[], layer: string): { today: string; against: string } {
  const out = observed.filter((o) => o.from === layer);
  return {
    today: out.map((o) => `${o.to} ${o.dependencies}`).join(', '),
    against: out.filter((o) => o.violations).map((o) => `${o.to} ${o.violations}`).join(', '),
  };
}

const ruleComment = (observed: ObservedPair[]) => (source: string): string[] => {
  const { today, against } = outgoing(observed, source);
  if (!today) return ['no dependency on another layer today'];
  return [`today: ${today}${against ? `; against these rules: ${against}` : ''}`];
};

function summary(observed: ObservedPair[], report: ArchReport | null): string[] {
  if (!report) return [];
  const deps = observed.reduce((n, o) => n + o.dependencies, 0);
  const against = observed.reduce((n, o) => n + o.violations, 0);
  const lines = [`Today: ${plural(deps, 'dependency', 'dependencies')} between layers, ${against} against these rules.`];
  const others = report.counts.violation - against;
  if (others > 0) lines.push(`Also ${plural(others, 'other violation')} (internal or private elements): see \`mapx check\`.`);
  return lines;
}

function profileOf(store: Store, repo: string | undefined): { archetype?: CodebaseArchetype; detectedFrameworks?: string[] } | null {
  if (!repo) return null;
  try {
    return JSON.parse(store.getMeta(`codebase_profile:${repo}`) ?? 'null');
  } catch {
    return null;
  }
}

/** Proposes a configuration for the index in `store` (the workspace at `workspace`). */
export function inferArchitecture(store: Store, workspace: string, options: InitOptions = {}): Proposal {
  const problem = initOptionsProblem(options);
  if (problem) throw new InitError(problem);
  const repos = options.repos?.length ? options.repos : [(store.raw.prepare('SELECT repo FROM files ORDER BY repo LIMIT 1').get() as { repo?: string } | undefined)?.repo ?? ''];
  const first = profileOf(store, repos[0]);
  const archetype: CodebaseArchetype = first?.archetype && LAYER_ORDER[first.archetype] ? first.archetype : 'mixed';
  const detected = [...new Set(repos.flatMap((r) => profileOf(store, r)?.detectedFrameworks ?? []))].sort();

  let proposal: Inferred;
  if (options.preset !== undefined || options.from === 'framework') {
    let preset = options.preset;
    const notes: string[] = [];
    if (preset === undefined) {
      const found = Object.keys(FRAMEWORK_PRESETS).filter((f) => detected.includes(f));
      if (!found.length) {
        throw new InitError(`No framework with a preset was detected in this index (detected: ${detected.join(', ') || 'none'}; presets exist for ${Object.keys(FRAMEWORK_PRESETS).join(', ')}). Pass a preset instead.`);
      }
      preset = FRAMEWORK_PRESETS[found[0]!]!;
      if (found.length > 1) notes.push(`Also detected: ${found.slice(1).join(', ')}; this proposal uses ${preset}.`);
    } else {
      const framework = Object.keys(FRAMEWORK_PRESETS).find((f) => FRAMEWORK_PRESETS[f] === preset);
      if (framework && !detected.includes(framework)) notes.push(`${framework} was not detected in this index (detected: ${detected.join(', ') || 'none'}).`);
    }
    proposal = fromPreset(store, workspace, preset, options, notes);
  } else if (options.from === 'clusters') {
    proposal = fromClusters(store, workspace, options);
  } else {
    proposal = fromRoles(store, workspace, archetype, options);
  }
  const { report, ...rest } = proposal;
  const violations = report?.counts.violation ?? 0;
  let baseline: Proposal['baseline'] = null;
  if (options.baseline && report) {
    const text = renderBaseline(report.findings);
    baseline = { text, entries: (JSON.parse(text) as { entries: unknown[] }).entries.length };
  }
  return { ...rest, archetype, violations, baseline };
}

/** A proposal before its baseline: the report it was evaluated to, if it could be. */
type Inferred = Omit<Proposal, 'baseline' | 'violations' | 'archetype'> & { report: ArchReport | null };

function baselineLine(workspace: string, options: InitOptions, report: ArchReport | null): string[] {
  if (!options.baseline || !report) return [];
  const file = display(workspace, defaultBaselinePath(workspace, options.view));
  return [`With the baseline (${file}), \`mapx check\` skips today's ${plural(report.counts.violation, 'violation')} and fails on new ones.`];
}

function fromRoles(store: Store, workspace: string, archetype: CodebaseArchetype, options: InitOptions): Inferred {
  const counts = new Map<string, number>();
  for (const row of store.raw.prepare("SELECT role, COUNT(*) AS n FROM files WHERE role IS NOT NULL AND role <> '' GROUP BY role ORDER BY role").all() as Array<{ role: string; n: number }>) {
    counts.set(row.role, row.n);
  }
  const order = LAYER_ORDER[archetype] as FileRole[];
  const placed = order.filter((r) => counts.has(r));
  const layers: ProposedLayer[] = placed.map((role) => ({ name: layerName(role), role, files: counts.get(role)! }));
  const unplaced = [...counts.keys()].filter((r) => !placed.includes(r as FileRole)).sort().map((role) => ({ role, files: counts.get(role)! }));
  const draft: Draft = {
    header: [],
    layers: layers.map((l) => ({ comment: [`role "${l.role}": ${plural(l.files, 'file')}`], layer: { name: l.name, selectors: [{ role: l.role }] } })),
    // A layer may depend on the layers after it in the archetype's order, as FlowValidator judges.
    rules: layers.map((l, i) => ({ source: l.name, list: layers.slice(i + 1).map((d) => d.name) })),
  };
  if (!layers.length) {
    draft.header = [`Proposed by \`mapx arch init\` from MapX roles and the "${archetype}" layer order (AR-15): no role has a place in it.`];
    const issues = [{ file: '.mapx/architecture.jsonc', pointer: '/layers', message: 'no role the index assigns has a place in the layer order: nothing to propose' }];
    return { source: 'roles', preset: null, parameters: {}, layers, unplaced, observed: [], text: renderDraft(draft), issues, notes: [], report: null };
  }
  const { report, issues } = evaluate(store, workspace, draftText(draft), options);
  const observed = observedOf(report);
  draft.header = [
    `Proposed by \`mapx arch init\` from MapX roles and the "${archetype}" layer order (AR-15).`,
    'Review it before relying on it: rename layers, replace role selectors with paths, tighten rules.',
    'Each layer may depend on the layers after it in that order; the comments give the dependencies the index has today.',
    ...(unplaced.length ? [`Roles left out (no place in the order): ${unplaced.map((u) => `${u.role} (${u.files})`).join(', ')}.`] : []),
    ...summary(observed, report),
    ...baselineLine(workspace, options, report),
  ];
  return { source: 'roles', preset: null, parameters: {}, layers, unplaced, observed, text: renderDraft(draft, ruleComment(observed)), issues, notes: [], report };
}

function fromClusters(store: Store, workspace: string, options: InitOptions): Inferred {
  const rows = store.raw.prepare(`
    SELECT m.cluster_name AS name, MIN(c.label) AS label, COUNT(DISTINCT m.file_path) AS files
    FROM cluster_membership m LEFT JOIN clusters c ON c.name = m.cluster_name AND c.repo = m.repo
    WHERE m.is_primary = 1 GROUP BY m.cluster_name ORDER BY m.cluster_name`).all() as Array<{ name: string; label: string | null; files: number }>;
  // A cluster name with glob characters would be read as a glob by the `cluster` selector: left out.
  const usable = rows.filter((r) => !/[*?[\]{}]/.test(r.name));
  const skipped = rows.filter((r) => !usable.includes(r)).map((r) => r.name);
  const taken = new Set<string>();
  const layers: ProposedLayer[] = usable.map((r) => {
    let name = layerName(r.name);
    for (let i = 2; taken.has(name); i++) name = `${layerName(r.name)}${i}`;
    taken.add(name);
    return { name, cluster: r.name, files: r.files };
  });
  const notes = skipped.length ? [`Clusters left out (their names read as globs): ${skipped.join(', ')}.`] : [];
  const draft: Draft = {
    header: [],
    layers: layers.map((l, i) => {
      const label = usable[i]!.label;
      return { comment: [`cluster "${l.cluster}"${label && label !== l.cluster ? ` (${label})` : ''}: ${plural(l.files, 'file')}`], layer: { name: l.name, selectors: [{ cluster: l.cluster! }] } };
    }),
    rules: layers.map((l) => ({ source: l.name, list: [] as string[] })),
  };
  if (!layers.length) {
    draft.header = ['Proposed by `mapx arch init --from clusters` (AR-15): the index has no clusters.'];
    const issues = [{ file: '.mapx/architecture.jsonc', pointer: '/layers', message: 'the index has no primary clusters: run `mapx scan`, or propose from roles' }];
    return { source: 'clusters', preset: null, parameters: {}, layers, unplaced: [], observed: [], text: renderDraft(draft), issues, notes, report: null };
  }
  // The observed cluster graph, from the layers with no allowance: every dependency between two of
  // them is a violation, counted per pair. The rules then allow exactly those pairs.
  const first = evaluate(store, workspace, draftText(draft), options);
  const order = new Map(layers.map((l, i) => [l.name, i]));
  for (const rule of draft.rules!) {
    rule.list = observedOf(first.report).filter((o) => o.from === rule.source && o.dependencies > 0).map((o) => o.to).sort((a, b) => order.get(a)! - order.get(b)!);
  }
  const { report, issues } = first.report ? evaluate(store, workspace, draftText(draft), options) : first;
  const observed = observedOf(report);
  draft.header = [
    'Proposed by `mapx arch init --from clusters` (AR-15): one layer per primary MapX cluster (see `mapx clusters`).',
    'The rules allow exactly the dependencies between clusters the index has today, so a new one fails `mapx check`.',
    'Review it before relying on it: rename layers, merge clusters, and remove the allowances you want gone.',
    ...notes,
    ...summary(observed, report),
    ...baselineLine(workspace, options, report),
  ];
  return { source: 'clusters', preset: null, parameters: {}, layers: withFiles(layers, report), unplaced: [], observed, text: renderDraft(draft, ruleComment(observed)), issues, notes, report };
}

/** The layers with the files the report counts (a cluster's own count is per primary membership). */
function withFiles(layers: ProposedLayer[], report: ArchReport | null): ProposedLayer[] {
  if (!report) return layers;
  const files = new Map(report.layers.map((l) => [l.name, l.files]));
  return layers.map((l) => ({ ...l, files: files.get(l.name) ?? l.files }));
}

/** Indexed paths of code files (not data or docs), sorted. */
function codePaths(store: Store): string[] {
  return (store.raw.prepare('SELECT path, language FROM files ORDER BY path').all() as Array<{ path: string; language: string | null }>)
    .filter((f) => !DATA_LANGUAGES.has((f.language ?? '').toLowerCase()))
    .map((f) => f.path);
}

/**
 * The value of a preset's folder parameter (`%root%` at the start of its path selectors) that fits
 * the indexed paths best: the folder (the repo root, or one up to three levels down) under which the
 * most of the preset's layers have files, then the most files, then the shortest, then the first by
 * name. Null when no folder gives any layer a file.
 */
function inferFolder(paths: string[], doc: ArchitectureDocument, param: string): { value: string; layers: number; total: number; files: number } | null {
  const ref = `%${param}%`;
  const globs = (doc.layers ?? []).map((l) => (l.selectors ?? [])
    .map((s) => s.path)
    .filter((p): p is string => typeof p === 'string' && p.startsWith(ref) && !p.slice(ref.length).includes('%'))
    .map((p) => picomatch(p.slice(ref.length), { dot: true })));
  const total = globs.filter((g) => g.length).length;
  if (!total) return null;
  const scores = new Map<string, { layers: Set<number>; files: number }>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let depth = 0; depth <= Math.min(3, segments.length - 1); depth++) {
      const prefix = depth ? `${segments.slice(0, depth).join('/')}/` : '';
      const rest = path.slice(prefix.length);
      let hit = false;
      globs.forEach((gs, i) => {
        if (!gs.some((g) => g(rest))) return;
        const score = scores.get(prefix) ?? { layers: new Set<number>(), files: 0 };
        score.layers.add(i);
        scores.set(prefix, score);
        hit = true;
      });
      if (hit) scores.get(prefix)!.files++;
    }
  }
  const best = [...scores].sort(([a, x], [b, y]) => y.layers.size - x.layers.size || y.files - x.files || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
  return best ? { value: best[0], layers: best[1].layers.size, total, files: best[1].files } : null;
}

/** The first comment line of a preset: what it is. */
export function presetTitle(id: string): string {
  const text = PRESETS[id];
  const line = typeof text === 'string' ? /^\/\/\s*(.*)$/m.exec(text)?.[1] ?? '' : '';
  return line.replace(new RegExp(`^${PRESET_PREFIX}${id}:\\s*`), '');
}

function fromPreset(store: Store, workspace: string, id: string, options: InitOptions, notes: string[]): Inferred {
  const raw = PRESETS[id]!;
  const doc = (typeof raw === 'string' ? parseArchitectureText(raw, PRESET_PREFIX + id).doc : raw) as ArchitectureDocument;
  const paths = codePaths(store);
  const parameters: Record<string, string> = {};
  const inferred: string[] = [];
  for (const [param, fallback] of Object.entries(doc.parameters ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const found = inferFolder(paths, doc, param);
    if (found) {
      // The folder goes into globs: a name like `svc (v2)/` must match itself, not a pattern (review of M5-17).
      parameters[param] = globLiteral(found.value);
      const escaped = parameters[param] !== found.value ? `, glob characters escaped from ${JSON.stringify(found.value)}` : '';
      inferred.push(`${param} = ${JSON.stringify(parameters[param])}: the folder where the most of the preset's layers have files (${found.layers} of ${found.total}, ${plural(found.files, 'file')}${escaped}).`);
    } else {
      // No layer has a file under any folder (ddd-contexts without a shared kernel, say): `src/` when
      // the index has one, else the repo root, so the contexts below can still be listed.
      parameters[param] = fallback === 'src/' && !paths.some((p) => p.startsWith('src/')) ? '' : fallback;
      inferred.push(`${param} = ${JSON.stringify(parameters[param])}: no folder matched the preset's layout; set it to the folder that holds the layer folders.`);
    }
  }
  const draft: Draft = { header: [], extends: PRESET_PREFIX + id, parameters };
  // ddd-contexts: one layer per bounded-context folder under root, the shared kernel aside.
  if (id === 'ddd-contexts') {
    const rootGlob = parameters['root'] ?? '';
    const root = globText(rootGlob);
    const kernel = (doc.layers ?? []).flatMap((l) => l.selectors.map((s) => s.path)).filter((p): p is string => typeof p === 'string')
      .map((p) => picomatch(p.replaceAll('%root%', rootGlob.replace(/%%/g, '%')), { dot: true }));
    const folders = new Map<string, number>();
    for (const p of paths) {
      if (!p.startsWith(root)) continue;
      const parts = p.slice(root.length).split('/');
      if (parts.length < 2 || kernel.some((k) => k(p))) continue;
      folders.set(parts[0]!, (folders.get(parts[0]!) ?? 0) + 1);
    }
    const taken = new Set((doc.layers ?? []).map((l) => l.name));
    draft.layers = [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([folder, files]) => {
      let name = layerName(folder);
      for (let i = 2; taken.has(name); i++) name = `${layerName(folder)}${i}`;
      taken.add(name);
      return { comment: [`bounded context: the folder ${root}${folder}/ (${plural(files, 'code file')})`], layer: { name, selectors: [{ path: `%root%${globLiteral(folder)}/**` }] } };
    });
    if (!draft.layers.length) notes.push(`No context folder under ${JSON.stringify(root)}: declare the contexts as layers here.`);
  }
  const { report, issues } = evaluate(store, workspace, draftText(draft), options);
  const observed = observedOf(report);
  const files = new Map((report?.layers ?? []).map((l) => [l.name, l.files]));
  const layerNames = report ? report.layers.map((l) => l.name) : [];
  const layers: ProposedLayer[] = layerNames.map((name) => {
    const own = draft.layers?.find((l) => l.layer.name === name);
    return { name, files: files.get(name) ?? 0, ...(own ? { path: own.layer.selectors[0]!.path } : {}) };
  });
  const width = Math.max(0, ...layerNames.map((n) => n.length));
  draft.header = [
    `Proposed by \`mapx arch init\` from the preset ${PRESET_PREFIX}${id} (AR-15): ${presetTitle(id)}`,
    'Review it before relying on it. Layers and rules declared here merge over the preset\'s (a layer of',
    'the same name replaces the preset\'s); `mapx arch layers` lists the result.',
    ...inferred,
    ...notes,
    ...(layers.length ? ['The layers on this index (files; dependencies on other layers today):'] : []),
    ...layers.map((l) => {
      const { today, against } = outgoing(observed, l.name);
      const what = l.files ? plural(l.files, 'file') : 'no files (an empty-layer warning)';
      return `  ${l.name.padEnd(width)}  ${what}${today ? `; → ${today}` : ''}${against ? `; against the rules: ${against}` : ''}`;
    }),
    ...summary(observed, report),
    ...baselineLine(workspace, options, report),
  ];
  return { source: 'preset', preset: id, parameters, layers, unplaced: [], observed, text: renderDraft(draft), issues, notes, report };
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────

export interface InitRequest extends InitOptions {
  /** Write the files; otherwise a dry run that writes nothing. */
  write?: boolean;
  /** Write over an existing configuration (and baseline). */
  force?: boolean;
  /** How the caller spells force and write in its messages: `--force`, `force: true`. */
  forceHint: string;
}

export interface InitResult {
  path: string;
  view: string | null;
  exists: boolean;
  written: boolean;
  source: Proposal['source'];
  preset: string | null;
  archetype: CodebaseArchetype;
  parameters: Record<string, string>;
  layers: ProposedLayer[];
  unplaced: Proposal['unplaced'];
  observed: ObservedPair[];
  violations: number;
  baseline: { path: string; entries: number; exists: boolean; written: boolean } | null;
  issues: ConfigIssue[];
  notes: string[];
  warnings: string[];
  config: string;
}

const display = (workspace: string, path: string) => relative(workspace, path).split('\\').join('/');

/**
 * Proposes (and with `write`, writes) a configuration for the workspace: what `mapx arch init` and
 * `mapx_arch_init` do. A dry run writes nothing. Writing refuses (InitError, exit 3) an existing
 * configuration or baseline without `force`, a view outside `.mapx/architecture/`, and a proposal
 * with issues; the refusals are checked before any file is written.
 */
export function runInit(store: Store, workspace: string, request: InitRequest): InitResult {
  const problem = initOptionsProblem(request);
  if (problem) throw new InitError(problem);
  if (request.view !== undefined) {
    const outside = viewProblem(workspace, request.view);
    if (outside) throw new InitError(outside.message);
  }
  const proposal = inferArchitecture(store, workspace, request);
  const target = architectureConfigPath(workspace, request.view);
  const baselineTarget = defaultBaselinePath(workspace, request.view);
  const path = display(workspace, target);
  const exists = existsSync(target);
  const baselineExists = existsSync(baselineTarget);
  const warnings: string[] = [];
  if (!request.baseline && baselineExists) {
    warnings.push(`${display(workspace, baselineTarget)} exists and applies to this configuration: entries that match no violation of it fail \`mapx check\` (exit 3). Regenerate it with \`mapx check --generate-baseline\`, or ask for a baseline here.`);
  }
  // A baseline is written when it has entries, or to replace an older one (an empty baseline).
  const writesBaseline = !!proposal.baseline && (proposal.baseline.entries > 0 || baselineExists);
  const result: InitResult = {
    path, view: request.view ?? null, exists, written: false, source: proposal.source, preset: proposal.preset, archetype: proposal.archetype,
    parameters: proposal.parameters, layers: proposal.layers, unplaced: proposal.unplaced, observed: proposal.observed, violations: proposal.violations,
    baseline: proposal.baseline ? { path: display(workspace, baselineTarget), entries: proposal.baseline.entries, exists: baselineExists, written: false } : null,
    issues: proposal.issues, notes: proposal.notes, warnings, config: proposal.text,
  };
  // A configuration that selects nothing (a layout the index does not have, review of M5-17): the
  // dry run warns; writing it needs force. Most layers empty is only a warning.
  const filled = proposal.layers.filter((l) => l.files > 0).length;
  const allEmpty = proposal.layers.length > 0 && filled === 0;
  if (allEmpty) {
    warnings.push(`Every layer is empty: no file in this index matches the proposal's selectors${proposal.preset ? ` (the ${proposal.preset} preset's layout, with ${Object.entries(proposal.parameters).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ') || 'no parameters'})` : ''}.${request.force ? '' : ` Writing it needs ${request.forceHint}.`}`);
  } else if (filled * 2 < proposal.layers.length) {
    warnings.push(`${proposal.layers.length - filled} of ${proposal.layers.length} layers are empty (${proposal.layers.filter((l) => !l.files).map((l) => l.name).join(', ')}): \`mapx check\` warns about each until code lands there.`);
  }
  if (!request.write) return result;
  // Never through a symlink, or into a .mapx/ that leads outside the workspace (review of M5-17).
  const targets = [target, ...(writesBaseline ? [baselineTarget] : [])];
  for (const t of targets) {
    const outside = outsideWorkspace(workspace, t);
    if (outside) throw new InitError(`${display(workspace, t)} ${outside}: mapx arch init writes only inside the workspace, never through a symlink. Nothing was written.`, { path: display(workspace, t) });
  }
  if (exists && !request.force) throw new InitError(`${path} already exists: nothing was written. Pass ${request.forceHint} to overwrite it, or choose another view.`, { path });
  if (writesBaseline && baselineExists && !request.force) {
    throw new InitError(`${display(workspace, baselineTarget)} already exists: nothing was written. Pass ${request.forceHint} to overwrite it.`, { path: display(workspace, baselineTarget) });
  }
  if (proposal.issues.length) throw new InitError('The proposal is not a valid configuration: nothing was written.', { path, issues: proposal.issues });
  if (allEmpty && !request.force) {
    throw new InitError(`Every layer of the proposal is empty: no file in this index matches it. Nothing was written. Check the preset or its parameters, or pass ${request.forceHint} to write it anyway.`, { path });
  }
  writeAll(workspace, [{ path: target, text: proposal.text }, ...(writesBaseline ? [{ path: baselineTarget, text: proposal.baseline!.text }] : [])]);
  result.written = true;
  if (writesBaseline) result.baseline!.written = true;
  return result;
}

/**
 * Why `target` would be written outside the workspace: it is a symlink, or the nearest existing
 * folder above it resolves outside (a symlinked `.mapx/`). Null when it is inside.
 */
function outsideWorkspace(workspace: string, target: string): string | null {
  let stat;
  try {
    stat = lstatSync(target, { throwIfNoEntry: false });
  } catch (err) {
    return `cannot be read (${(err as NodeJS.ErrnoException).code ?? err})`;
  }
  if (stat?.isSymbolicLink()) return 'is a symbolic link';
  let dir = dirname(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    const rel = relative(realpathSync(workspace), realpathSync(dir));
    if (rel.split(/[\\/]/)[0] === '..' || isAbsolute(rel)) return 'is in a folder that resolves outside the workspace (a symlink)';
  } catch { /* unresolvable: the write reports it */ }
  return null;
}

/**
 * Writes every file or none (review of M5-17): each goes to a temporary file beside its target
 * first; then each target is moved aside and replaced. Any failure restores what was there and
 * removes the temporary files, and is an InitError (exit 3), never a half-written configuration.
 */
export function writeAll(workspace: string, files: Array<{ path: string; text: string }>): void {
  const tag = `.mapx-init-${process.pid}`;
  const staged: string[] = [];
  const replaced: Array<{ path: string; backup: string | null }> = [];
  const fail = (path: string, err: unknown): never => {
    for (const { path: p, backup } of replaced.reverse()) {
      try {
        if (backup) renameSync(backup, p);
        else rmSync(p, { force: true });
      } catch { /* best effort: the message names the file */ }
    }
    for (const s of staged) rmSync(s, { force: true });
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new InitError(`Cannot write ${display(workspace, path)}${code ? ` (${code})` : ''}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`, { path: display(workspace, path) });
  };
  // Only a regular file is ever replaced: a directory in the way is a problem, never moved or deleted.
  for (const f of files) {
    let stat;
    try {
      stat = lstatSync(f.path, { throwIfNoEntry: false });
    } catch (err) {
      fail(f.path, err); // ENOTDIR, EACCES, ELOOP: still exit 3, still nothing changed
    }
    if (stat && !stat.isFile()) fail(f.path, new Error('it exists and is not a file'));
  }
  for (const f of files) {
    const tmp = `${f.path}${tag}.tmp`;
    try {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(tmp, f.text, { flag: 'wx' });
      staged.push(tmp);
    } catch (err) {
      fail(f.path, err);
    }
  }
  for (const f of files) {
    const tmp = `${f.path}${tag}.tmp`;
    let backup: string | null = null;
    try {
      if (existsSync(f.path)) {
        backup = `${f.path}${tag}.bak`;
        renameSync(f.path, backup);
      }
      replaced.push({ path: f.path, backup });
      renameSync(tmp, f.path);
      staged.splice(staged.indexOf(tmp), 1);
    } catch (err) {
      fail(f.path, err);
    }
  }
  for (const { backup } of replaced) if (backup) rmSync(backup, { force: true });
}
