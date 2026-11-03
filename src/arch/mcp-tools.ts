// The architecture-rules agent surface (M5-14; docs/research/deptrac AR-19): five MCP tools that
// wrap the functions behind `mapx check` and the `mapx arch` subcommands, so the CLI and MCP give
// the same answers. Each returns JSON by default and caps its lists, reporting the totals. A
// failure is a tool result with `isError: true` and `{ error, exitCode }`, the code meaning what
// it means for the CLI (AR-17): 3 a configuration or usage error, 4 a missing or stale index.
import type { Config } from '../core/config.js';
import type { Store } from '../core/store.js';
import { ConfigError, loadArchitectureConfig, PRESETS } from './config.js';
import { CHECK_RULES, EXIT, exitCode, shownReport, CONFIG_RULES, type CheckOptions } from './check.js';
import { configErrorReport, runArchitecture, type ArchReport, type Finding } from './report.js';
import { renderTable } from './reporters/table.js';
import { EDGE_TYPES } from './schema.js';
import { globOrRegex } from './selectors/index.js';
import { indexGate } from './index-gate.js';
import {
  changedSince, IntrospectError, isAllowed, layerMembers, layerSummaries, openArchitecture, unassignedElements, whichLayers, workspacePath,
  type ArchContext,
} from './introspect.js';
import { InitError, INIT_SOURCES, initOptionsProblem, runInit } from './infer.js';

export const ARCH_TOOL_NAMES = ['mapx_arch_check', 'mapx_arch_layers', 'mapx_arch_allowed', 'mapx_arch_explain', 'mapx_arch_init'] as const;
export type ArchToolName = typeof ARCH_TOOL_NAMES[number];

/** Default caps: findings of mapx_arch_check, members and unassigned elements of mapx_arch_layers. */
export const CHECK_LIMIT = 50;
export const LAYERS_LIMIT = 100;

const dir = { type: 'string', description: 'Target project directory (absolute or relative path). Defaults to the directory set when starting the MCP server.' };
const view = { type: 'string', description: 'A view: .mapx/architecture/<view>.jsonc instead of .mapx/architecture.jsonc' };
const sync = { type: 'boolean', description: 'Sync the index first when files changed since the last scan (otherwise a stale index is an error, exitCode 4)', default: false };
const ERRORS = 'A failure is a tool error with JSON { error, exitCode, issues?, candidates? }: exitCode 3 for a configuration or usage error, 4 for a missing or stale index (AR-17).';

export const ARCH_TOOLS = [
  {
    name: 'mapx_arch_check',
    description: `Check the architecture rules (.mapx/architecture.jsonc) against the index, as \`mapx check --format json\` does. Returns the report { counts, findings, layers, layerEdges, configErrors, selection } plus exitCode (0 clean, 1 violations, 2 uncovered with failOnUncovered), total (findings before the cap), limit and truncated. Violations are a result, not an error. Filters: layer, rule, file, since. ${ERRORS}`,
    inputSchema: {
      type: 'object',
      properties: {
        view,
        layer: { type: 'string', description: 'Only findings about this layer' },
        rule: { type: 'string', description: `Only findings of this rule (${CHECK_RULES.join(', ')})` },
        file: { type: 'string', description: 'Only findings whose source or target file is under this path prefix or matches this glob' },
        since: { type: 'string', description: 'Only findings whose source or target file changed since this git revision (committed, staged, unstaged, untracked); refused (exitCode 3) when unknown, starting with "-", or containing whitespace, quotes or shell characters' },
        failOn: { type: 'string', enum: ['error', 'warn'], description: 'Lowest severity that makes exitCode 1', default: 'error' },
        reportUncovered: { type: 'boolean', description: 'Show dependencies on elements in no layer', default: false },
        failOnUncovered: { type: 'boolean', description: 'exitCode 2 when a dependency targets an element in no layer', default: false },
        reportSkipped: { type: 'boolean', description: 'Show violations the baseline skips', default: false },
        reportAllowed: { type: 'boolean', description: 'Show allowed dependencies too', default: false },
        limit: { type: 'number', description: `Most findings to return (default ${CHECK_LIMIT}; 0 returns all)`, default: CHECK_LIMIT },
        format: { type: 'string', enum: ['json', 'text'], description: 'json (default) or text: the whole table `mapx check` prints (limit applies to json only)', default: 'json' },
        sync,
        dir,
      },
    },
  },
  {
    name: 'mapx_arch_layers',
    description: `The layers of the architecture configuration (AR-13a–c), as \`mapx arch layers\` / \`mapx arch unassigned --json\`. Without arguments: { layers: [{ name, overlay, elements, files }] }. With layer: its members (files and top-level symbols; nested adds members of types), why naming the selector that matched each (and for a hierarchy selector, chain: the inheritance path that matched). With unassigned: true: the elements in no layer (kind, path filters). Lists are capped by limit, with total and truncated. ${ERRORS}`,
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'A layer name: list its members' },
        why: { type: 'boolean', description: 'With layer: name the selector that put each member in it', default: false },
        nested: { type: 'boolean', description: 'List members of types too (methods, properties)', default: false },
        unassigned: { type: 'boolean', description: 'List the files and top-level symbols in no layer instead', default: false },
        kind: { type: 'string', description: 'With unassigned: only file, symbol, or a symbol kind (class, function, …)' },
        path: { type: 'string', description: 'With unassigned: only under this path prefix, or matching this glob' },
        limit: { type: 'number', description: `Most members or elements to return (default ${LAYERS_LIMIT}; 0 returns all)`, default: LAYERS_LIMIT },
        view,
        sync,
        dir,
      },
    },
  },
  {
    name: 'mapx_arch_allowed',
    description: `Pre-flight check before writing an import or call (AR-19): may <from> depend on <to>? Each end is a layer name, a file path or a symbol (qualified, scoped like Order::run, or a bare name). Returns \`mapx arch allowed --json\`: { allowed, rule, severity, reason, exitCode (1 when mapx check would fail), decisions[] (per edge type and source layer), allowedTypes, allowedLayers, alternatives[{ layer, total, symbols[{ element, file, match: supertype|name }] }] }. A refused dependency is a result, not an error. ${ERRORS}`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source: a layer, file or symbol' },
        to: { type: 'string', description: 'Target: a layer, file or symbol' },
        type: { type: 'string', enum: [...EDGE_TYPES], description: 'Decide for this edge type only (default: the types the index has between the two, else every type in scope)' },
        view,
        sync,
        dir,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'mapx_arch_explain',
    description: `Why an element is in its layers, and why a dependency is allowed or a violation (AR-19): the selector trace of \`mapx arch which\` and the rule trace of \`mapx arch allowed\`. Returns { element: { query, matches[{ element, layers, private, trace[{ layer, selector, via, chain? }], inScope }] }, layer?: { name, matches[{ element, inLayer, selector?, via?, chain? }] }, dependency?: <mapx_arch_allowed answer> }. ${ERRORS}`,
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'A file path, qualified name, scoped name (Order::run) or symbol name' },
        layer: { type: 'string', description: 'Also say whether each match is in this layer, and through which selector' },
        to: { type: 'string', description: 'Also explain the dependency element → to (a layer, file or symbol)' },
        type: { type: 'string', enum: [...EDGE_TYPES], description: 'With to: decide for this edge type only' },
        view,
        sync,
        dir,
      },
      required: ['element'],
    },
  },
  {
    name: 'mapx_arch_init',
    description: `Propose an architecture configuration (AR-15), as \`mapx arch init --json\` does: from MapX roles and the archetype's layer order (default), from the primary clusters (from: clusters, rules = today's cluster graph), from the detected framework's preset (from: framework), or from a shipped preset (preset: laravel, nestjs, django, layered, clean, hexagonal, ddd-contexts, feature-sliced) with its folder parameters inferred. The JSONC comments give the observed layer graph. baseline: true also proposes a baseline of today's violations, so \`mapx check\` passes on day one. Never writes unless write: true, and never over an existing configuration or baseline unless force: true. Returns { path, view, exists, written, source, preset, archetype, parameters, layers[{ name, files, role?, cluster?, path? }], unplaced[{ role, files }], observed[{ from, to, dependencies, violations }], violations, baseline: { path, entries, exists, written } | null, issues, notes, warnings, config (the JSONC) }. ${ERRORS}`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: [...INIT_SOURCES], description: 'Where layers come from: roles (default), clusters, or framework (the preset of the detected framework)' },
        preset: { type: 'string', enum: Object.keys(PRESETS).sort(), description: 'Start from this shipped preset (mapx:preset/<id>) instead; excludes from' },
        baseline: { type: 'boolean', description: 'Also propose (and with write, write) .mapx/architecture.baseline.json listing today\'s violations; needs a current index (sync: true syncs first)', default: false },
        write: { type: 'boolean', description: 'Write the proposal to .mapx/architecture.jsonc (or the view)', default: false },
        force: { type: 'boolean', description: 'With write: overwrite an existing configuration and baseline, or write a proposal whose every layer is empty (never through a symlink)', default: false },
        view,
        sync,
        dir,
      },
    },
  },
];

type Loaded = { config: Config; store: Store };
export interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
export interface ArchToolEnv<C extends Loaded> {
  /** Opens the index of the workspace (the caller closes its store). */
  load: () => Promise<C>;
  /** Brings a stale index up to date (`sync: true`). */
  sync: (context: C) => Promise<unknown>;
}

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (exitCode: number, error: string, extra: Record<string, unknown> = {}): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify({ error, ...extra, exitCode }, null, 2) }], isError: true });

class UsageError extends Error {}

const str = (args: Record<string, unknown>, key: string, required = false): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new UsageError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new UsageError(`"${key}" must be a string`);
  return v;
};
const limitOf = (args: Record<string, unknown>, fallback: number): number => {
  const v = args.limit ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new UsageError(`"limit" must be a whole number, not ${JSON.stringify(v)}`);
  return v === 0 ? Infinity : v;
};
const capped = <T>(list: T[], limit: number) => ({ list: list.slice(0, limit), truncated: list.length > limit });

/** Runs one of ARCH_TOOL_NAMES on the workspace at `workspace`. */
export async function runArchTool<C extends Loaded>(name: ArchToolName, args: Record<string, unknown>, workspace: string, env: ArchToolEnv<C>): Promise<ToolResult> {
  try {
    validate(name, args);
    if (name === 'mapx_arch_init') return await init(args, workspace, env);
    const gate = await indexGate(workspace, env.load, {
      sync: args.sync === true ? env.sync : undefined,
      syncAdvice: '`sync: true`',
      updateAdvice: '`mapx_sync`',
    });
    if ('problems' in gate) return failure(EXIT.index, gate.problems.join(' '));
    const { config, store } = gate.context;
    const repoPaths = Object.fromEntries(config.repos.map((r) => [r.name, r.path]));
    if (name === 'mapx_arch_check') return check(args, workspace, store, repoPaths);
    // The introspection tools: as `mapx arch <subcommand>` (src/cli.ts archQuestion).
    const v = str(args, 'view');
    let ctx: ArchContext | null;
    try {
      ctx = openArchitecture(workspace, store, { view: v, repoPaths });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      return failure(EXIT.config, 'Invalid architecture configuration', { issues: err.issues });
    }
    if (!ctx) return failure(EXIT.config, noConfiguration(workspace, v));
    if (ctx.policy.errors.length) return failure(EXIT.config, `Invalid architecture configuration: ${ctx.policy.errors.join('; ')}`);
    if (name === 'mapx_arch_layers') return layers(args, ctx);
    if (name === 'mapx_arch_allowed') return json(isAllowed(ctx, str(args, 'from', true)!, str(args, 'to', true)!, { edgeType: edgeType(args) }));
    return explain(args, ctx);
  } catch (err) {
    if (err instanceof UsageError) return failure(EXIT.config, err.message);
    if (err instanceof IntrospectError) return failure(EXIT.config, err.message, err.candidates.length ? { candidates: err.candidates } : {});
    return failure(EXIT.index, `${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const noConfiguration = (workspace: string, v: string | undefined) => (v
  ? `No view "${v}" in ${workspace}: .mapx/architecture/${v}.jsonc does not exist.`
  : `No architecture configuration in ${workspace}: create .mapx/architecture.jsonc (see docs/architecture-rules.md), or call mapx_arch_init for a proposal.`);

function edgeType(args: Record<string, unknown>): string | undefined {
  const type = str(args, 'type');
  if (type !== undefined && !(EDGE_TYPES as readonly string[]).includes(type)) throw new IntrospectError(`type "${type}" is not an edge type (${EDGE_TYPES.join(', ')})`);
  return type;
}

/**
 * `since` as a git revision: never an option (`-…`), and without shell metacharacters, whitespace
 * or control characters, whatever reaches git later (review of M5-14; git-tracker passes argument
 * arrays since M5-08-R1). A revision git does not know is changedSince's IntrospectError: exit 3.
 */
function sinceRef(args: Record<string, unknown>): string | undefined {
  const since = str(args, 'since');
  if (since !== undefined && (!since.trim() || since.startsWith('-') || /[\s$`;&|<>()'"\\\x00-\x1f\x7f]/.test(since))) {
    throw new UsageError(`since "${since}" is not a git revision: it must not start with "-" or contain whitespace, quotes or shell characters`);
  }
  return since;
}

/**
 * Every argument checked before the index is (as the CLI parses its options first): a usage error
 * is exit 3 even on a stale or missing index (review of M5-14).
 */
function validate(name: ArchToolName, args: Record<string, unknown>): void {
  for (const key of ['view', 'layer', 'rule', 'file', 'since', 'format', 'failOn', 'kind', 'path', 'from', 'to', 'element', 'type', 'preset']) str(args, key);
  for (const key of ['sync', 'why', 'nested', 'unassigned', 'write', 'force', 'baseline', 'reportUncovered', 'failOnUncovered', 'reportSkipped', 'reportAllowed']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new UsageError(`"${key}" must be true or false`);
  }
  edgeType(args);
  if (name === 'mapx_arch_check') {
    const format = str(args, 'format') ?? 'json';
    if (format !== 'json' && format !== 'text') throw new UsageError(`format must be json or text, not "${format}"`);
    const failOn = str(args, 'failOn') ?? 'error';
    if (failOn !== 'error' && failOn !== 'warn') throw new UsageError(`failOn must be error or warn, not "${failOn}"`);
    limitOf(args, CHECK_LIMIT);
    sinceRef(args);
  }
  if (name === 'mapx_arch_layers') {
    limitOf(args, LAYERS_LIMIT);
    if (args.unassigned === true && args.layer !== undefined) throw new UsageError('give layer or unassigned, not both');
  }
  if (name === 'mapx_arch_allowed') { str(args, 'from', true); str(args, 'to', true); }
  if (name === 'mapx_arch_explain') str(args, 'element', true);
  if (name === 'mapx_arch_init') {
    const problem = initOptionsProblem({ from: str(args, 'from'), preset: str(args, 'preset'), view: str(args, 'view') });
    if (problem) throw new UsageError(problem);
  }
}

// ─── mapx_arch_check ─────────────────────────────────────────────────────────────────────────

function check(args: Record<string, unknown>, workspace: string, store: Store, repoPaths: Record<string, string>): ToolResult {
  const format = str(args, 'format') ?? 'json';
  if (format !== 'json' && format !== 'text') throw new UsageError(`format must be json or text, not "${format}"`);
  const failOn = str(args, 'failOn') ?? 'error';
  if (failOn !== 'error' && failOn !== 'warn') throw new UsageError(`failOn must be error or warn, not "${failOn}"`);
  const limit = limitOf(args, CHECK_LIMIT);
  const v = str(args, 'view');
  const options: CheckOptions = {
    reportUncovered: args.reportUncovered === true, failOnUncovered: args.failOnUncovered === true,
    reportSkipped: args.reportSkipped === true, reportAllowed: args.reportAllowed === true,
    failOn, layer: str(args, 'layer'), rule: str(args, 'rule'),
  };
  const selection = { view: v ?? null, layer: options.layer ?? null, rule: options.rule ?? null };
  // 3: no configuration, or one that cannot be used (as `mapx check`).
  let archConfig;
  try {
    archConfig = loadArchitectureConfig(workspace, { view: v });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { ...json({ error: 'Invalid architecture configuration', ...configErrorReport(err), selection, exitCode: EXIT.config }), isError: true };
  }
  if (!archConfig) return failure(EXIT.config, noConfiguration(workspace, v));
  const layerNames = archConfig.layers.map((l) => l.name);
  if (options.layer && !layerNames.includes(options.layer)) throw new IntrospectError(`layer "${options.layer}" is not a layer of this configuration (${layerNames.join(', ')})`, layerNames);
  if (options.rule && !CHECK_RULES.includes(options.rule)) throw new IntrospectError(`rule "${options.rule}" is not a rule (${CHECK_RULES.join(', ')})`, CHECK_RULES);
  // The MCP-only filters: by file (prefix or glob) and by the files changed since a git ref.
  const fileArg = str(args, 'file');
  const since = sinceRef(args);
  const keeps: Array<(path: string) => boolean> = [];
  if (fileArg !== undefined) {
    const p = workspacePath(workspace, fileArg);
    const match = /[*?[{]/.test(p) ? globOrRegex(p) : (s: string) => p === '' || s === p || s.startsWith(`${p}/`);
    if (!store.getAllFiles().some((f) => match(f.path as string))) throw new UsageError(`file "${fileArg}" matches no indexed file`);
    keeps.push(match);
  }
  if (since !== undefined) {
    const changed = new Set(changedSince(workspace, since, repoPaths));
    keeps.push((path) => changed.has(path));
  }
  const full = runArchitecture(workspace, { store, repoPaths, view: v })!;
  const filtered: ArchReport = keeps.length ? withFindings(full, full.findings.filter((f) => isConfigError(f) || keeps.every((keep) => [f.source?.file, f.target?.file].some((p) => p !== undefined && keep(p))))) : full;
  const code = exitCode(filtered, options);
  const shown = { ...shownReport(filtered, options), selection };
  const { list, truncated } = capped(shown.findings, limit);
  const out = { ...shown, findings: list };
  if (code === EXIT.config) return { ...json({ error: 'Invalid architecture configuration or baseline', ...out, exitCode: code, total: shown.findings.length, limit: Number.isFinite(limit) ? limit : 0, truncated }), isError: true };
  // The table is the CLI's, whole: its summary counts errors among the findings it lists.
  if (format === 'text') return { content: [{ type: 'text', text: renderTable(shown) }] };
  return json({ ...out, exitCode: code, total: shown.findings.length, limit: Number.isFinite(limit) ? limit : 0, truncated });
}

const isConfigError = (f: Finding) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '');

function withFindings(report: ArchReport, findings: Finding[]): ArchReport {
  const counts = Object.fromEntries(Object.keys(report.counts).map((k) => [k, 0])) as ArchReport['counts'];
  for (const f of findings) counts[f.kind]++;
  return { ...report, findings, counts };
}

// ─── mapx_arch_layers ────────────────────────────────────────────────────────────────────────

function layers(args: Record<string, unknown>, ctx: ArchContext): ToolResult {
  const layer = str(args, 'layer');
  const limit = limitOf(args, LAYERS_LIMIT);
  if (args.unassigned === true) {
    if (layer !== undefined) throw new UsageError('give layer or unassigned, not both');
    const r = unassignedElements(ctx, { kind: str(args, 'kind'), path: str(args, 'path'), nested: args.nested === true });
    const { list, truncated } = capped(r.elements, limit);
    return json({ ...r, elements: list, truncated });
  }
  if (layer === undefined) return json(layerSummaries(ctx));
  const m = layerMembers(ctx, layer, { why: args.why === true, nested: args.nested === true });
  const { list, truncated } = capped(m.members, limit);
  return json({ ...m, members: list, truncated });
}

// ─── mapx_arch_explain ───────────────────────────────────────────────────────────────────────

function explain(args: Record<string, unknown>, ctx: ArchContext): ToolResult {
  const query = str(args, 'element', true)!;
  const element = whichLayers(ctx, query);
  const out: Record<string, unknown> = { element };
  const layer = str(args, 'layer');
  if (layer !== undefined) {
    const names = ctx.config.layers.map((l) => l.name);
    if (!names.includes(layer)) throw new IntrospectError(`"${layer}" is not a layer of this configuration (${names.join(', ')})`, names);
    out.layer = {
      name: layer,
      matches: element.matches.map((m) => {
        const t = m.trace.find((x) => x.layer === layer);
        return { element: m.element, inLayer: !!t, ...(t ? { selector: t.selector, via: t.via, ...(t.chain ? { chain: t.chain } : {}) } : {}) };
      }),
    };
  }
  const to = str(args, 'to');
  if (to !== undefined) out.dependency = isAllowed(ctx, query, to, { edgeType: edgeType(args) });
  return json(out);
}

// ─── mapx_arch_init ──────────────────────────────────────────────────────────────────────────

async function init<C extends Loaded>(args: Record<string, unknown>, workspace: string, env: ArchToolEnv<C>): Promise<ToolResult> {
  // A proposal reads roles, which a stale index still has: only a missing or outdated one fails.
  // A baseline lists today's violations, so it needs a current index, as `mapx check` does.
  const gate = await indexGate(workspace, env.load, {
    allowStale: args.baseline !== true, sync: args.sync === true ? env.sync : undefined, syncAdvice: '`sync: true`', updateAdvice: '`mapx_sync`',
  });
  if ('problems' in gate) return failure(EXIT.index, gate.problems.join(' '));
  const { config, store } = gate.context;
  try {
    return json(runInit(store, workspace, {
      from: str(args, 'from') as never, preset: str(args, 'preset'), baseline: args.baseline === true, view: str(args, 'view'),
      write: args.write === true, force: args.force === true, forceHint: '`force: true`',
      repoPaths: Object.fromEntries(config.repos.map((r) => [r.name, r.path])), repos: config.repos.map((r) => r.name),
    }));
  } catch (err) {
    if (err instanceof InitError) return failure(EXIT.config, err.message, err.extra);
    throw err;
  }
}
