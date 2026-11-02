// Introspection (M5-08; docs/research/deptrac AR-13a–g, Deptrac's debug:* and changed-files):
// questions about the architecture configuration answered from the index without a whole check.
//
//   layerMembers       AR-13a  which elements are in layer L, and through which selector
//   whichLayers        AR-13b  which layers element E is in, and why
//   unassignedElements AR-13c  what is in no layer
//   layerDependencies  AR-13d  the concrete edges from layer L1 to L2
//   unusedAllowances   AR-13e  allowances used at most N times
//   changedLayers      AR-13f  the layers some files touch, and the layers that depend on them
//   isAllowed          AR-13g  would a dependency A → B be allowed (the agent pre-flight check)
//
// Each returns a plain JSON-ready object: `mapx arch <subcommand> --format json` prints it as is,
// and the MCP tools (M5-14) and rule-derived smells (M5-16) call the same functions.
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { getChangedFiles, isGitRepo } from '../core/git-tracker.js';
import type { Store } from '../core/store.js';
import { loadArchitectureConfig, type LoadOptions } from './config.js';
import { SYMBOL_KINDS, type ArchitectureConfig } from './schema.js';
import { getMembership, type LayerMembership, type TraceEntry } from './membership.js';
import { decide, expandPolicy, type ExpandedPolicy } from './policy.js';
import {
  decideEdge, edgeScope, elementName, evaluateEdges, reportElement,
  type Dependency, type EdgeScope, type Evaluation, type FindingSeverity, type TargetLayers,
} from './evaluate.js';
import type { Element } from './elements.js';
import { globOrRegex } from './selectors/index.js';

/** A question that cannot be answered as asked: an unknown layer or element, an ambiguous name. Exit 3. */
export class IntrospectError extends Error {
  constructor(message: string, readonly candidates: string[] = []) {
    super(message);
    this.name = 'IntrospectError';
  }
}

/** A loaded configuration over an index: what every question needs, the evaluation computed once. */
export interface ArchContext {
  dir: string;
  config: ArchitectureConfig;
  store: Store;
  membership: LayerMembership;
  policy: ExpandedPolicy;
  /** Repo name → its path in the workspace (`.` for the root repo). */
  repoPaths: Record<string, string>;
  /** What the configuration evaluates: edge types, paths (`scope.include`/`exclude`), inferred edges. */
  scope: EdgeScope;
  /** Every stored edge decided under the configuration (computed on first use). */
  evaluation(): Evaluation;
}

/**
 * The context for the configuration of `dir` (or a view) over the index in `store`; null when the
 * workspace has no configuration. An invalid configuration throws `ConfigError`.
 */
export function openArchitecture(dir: string, store: Store, options: LoadOptions & { repoPaths?: Record<string, string> } = {}): ArchContext | null {
  const config = loadArchitectureConfig(dir, options);
  if (!config) return null;
  const membership = getMembership(store, dir, config, join(dir, '.mapx', 'mapx.db'), options.repoPaths);
  const policy = expandPolicy(config);
  let evaluation: Evaluation | null = null;
  return { dir, config, store, membership, policy, repoPaths: options.repoPaths ?? {}, scope: edgeScope(config), evaluation: () => (evaluation ??= evaluateEdges(store, config, membership, policy)) };
}

// ─── Shared shapes ────────────────────────────────────────────────────────────────────────────

/** An element as introspection names it: a symbol's qualified name or a file's path. */
export interface ElementRef {
  element: string;
  kind: 'file' | 'symbol';
  /** class, method, function … (symbols only). */
  symbolKind?: string;
  file: string;
}

export const elementRef = (el: Element): ElementRef => ({
  element: elementName(el), kind: el.kind, ...(el.symbolKind ? { symbolKind: el.symbolKind } : {}), file: el.file.path,
});

/** Files and top-level symbols, or every element with `nested`. */
const listed = (el: Element, nested: boolean) => nested || el.kind === 'file' || el.topLevel;

/** Files first within a path, then symbols by qualified name. */
function byFile(a: Element, b: Element): number {
  if (a.file.path !== b.file.path) return a.file.path < b.file.path ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
  return a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0;
}

function layerOrder(ctx: ArchContext): (a: string, b: string) => number {
  const order = new Map(ctx.config.layers.map((l, i) => [l.name, i]));
  return (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
}

function requireLayer(ctx: ArchContext, name: string, what = 'layer'): void {
  const names = ctx.config.layers.map((l) => l.name);
  if (!names.includes(name)) throw new IntrospectError(`"${name}" is not a ${what} of this configuration (${names.join(', ')})`, names);
}

/** A workspace-relative POSIX path for a path given absolute, with `./` or with backslashes. */
export function workspacePath(dir: string, path: string): string {
  const p = isAbsolute(path) ? relative(dir, path) : path;
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

const nameIndexes = new WeakMap<object, { byQn: Map<string, Element[]>; byName: Map<string, Element[]>; byMember: Map<string, Element[]>; byScoped: Map<string, Element[]> }>();

/**
 * The elements a query names: an element id (`file:…`, `symbol:…`), an indexed file path, a
 * qualified name, a scoped name (`Order::run`, `Order.run`), a top-level symbol's bare name, or
 * else a member's (`run`).
 * The first form that matches decides; an empty list when none does.
 */
export function resolveElements(ctx: ArchContext, query: string): Element[] {
  const view = ctx.membership.view;
  const byId = view.byId.get(query);
  if (byId) return [byId];
  const path = workspacePath(ctx.dir, query);
  const file = view.byId.get(`file:${path}`);
  if (file) return [file];
  let idx = nameIndexes.get(view);
  if (!idx) {
    idx = { byQn: new Map(), byName: new Map(), byMember: new Map(), byScoped: new Map() };
    const add = (m: Map<string, Element[]>, k: string, e: Element) => { const l = m.get(k); if (l) l.push(e); else m.set(k, [e]); };
    for (const e of view.elements) {
      if (e.kind !== 'symbol') continue;
      add(idx.byQn, e.qualifiedName, e);
      add(e.topLevel ? idx.byName : idx.byMember, e.name!, e);
      if (e.scope) for (const sep of ['::', '.', '#', '\\']) add(idx.byScoped, `${e.scope}${sep}${e.name}`, e);
    }
    nameIndexes.set(view, idx);
  }
  return idx.byQn.get(query) ?? idx.byScoped.get(query) ?? idx.byName.get(query) ?? idx.byMember.get(query) ?? [];
}

/** The one element a query names; an IntrospectError when it names none or several. */
export function resolveElement(ctx: ArchContext, query: string): Element {
  const found = resolveElements(ctx, query);
  if (!found.length) throw new IntrospectError(`"${query}" is not an indexed file or symbol, nor a layer`);
  if (found.length > 1) {
    const candidates = found.map((e) => elementName(e)).sort();
    throw new IntrospectError(`"${query}" names ${found.length} elements; use one of: ${candidates.join(', ')}`, candidates);
  }
  return found[0]!;
}

// ─── AR-13a: layer members ────────────────────────────────────────────────────────────────────

export interface LayerSummary { name: string; overlay: boolean; elements: number; files: number }
export interface LayerMember extends ElementRef { selector?: string; via?: string }
export interface LayerMembers extends LayerSummary { total: number; members: LayerMember[] }

/** Every layer with its size (as `mapx check` counts: every element, and the files among them). */
export function layerSummaries(ctx: ArchContext): { layers: LayerSummary[] } {
  const m = ctx.membership;
  return {
    layers: m.layers.map((l) => ({
      name: l.name, overlay: !!l.overlay, elements: m.members(l.name).length, files: new Set(m.members(l.name).map((e) => e.file.path)).size,
    })),
  };
}

/**
 * The members of `layer`: files and top-level symbols (every symbol with `nested`). With `why`,
 * each names the selector that matched (`selectors[0].all[0].path`) and `via`: `self`, or the
 * top-level symbol that put a file in the layer.
 */
export function layerMembers(ctx: ArchContext, layer: string, options: { why?: boolean; nested?: boolean } = {}): LayerMembers {
  requireLayer(ctx, layer);
  const summary = layerSummaries(ctx).layers.find((l) => l.name === layer)!;
  const members = ctx.membership.members(layer).filter((e) => listed(e, !!options.nested)).sort(byFile).map((e): LayerMember => {
    if (!options.why) return elementRef(e);
    const t = ctx.membership.explain(e).find((x) => x.layer === layer)!;
    return { ...elementRef(e), selector: t.selector, via: t.via };
  });
  return { ...summary, total: members.length, members };
}

// ─── AR-13b: which layers ─────────────────────────────────────────────────────────────────────

export interface ElementLayers extends ElementRef {
  /** Every layer the element is in, overlays included, in configuration order. */
  layers: string[];
  /** The layers whose `private` selectors match it (AR-07). */
  private: string[];
  /** Why: per layer, the selector that matched and `self` or the top-level symbol that brought a file in. */
  trace: TraceEntry[];
  /** `scope.include`/`scope.exclude` admit its file: otherwise `mapx check` evaluates none of its edges. */
  inScope: boolean;
}

/** The layers of every element the query names (see resolveElements), with the selector trace. */
export function whichLayers(ctx: ArchContext, query: string): { query: string; matches: ElementLayers[] } {
  const found = resolveElements(ctx, query);
  if (!found.length) throw new IntrospectError(`"${query}" is not an indexed file or symbol`);
  return {
    query,
    matches: found.sort(byFile).map((e) => ({
      ...elementRef(e), layers: ctx.membership.of(e), private: ctx.membership.privateIn(e), trace: ctx.membership.explain(e), inScope: ctx.scope.path(e.file.path),
    })),
  };
}

// ─── AR-13c: unassigned ───────────────────────────────────────────────────────────────────────

export interface UnassignedOptions {
  /** `file`, `symbol`, or a symbol kind (`class`, `function` …). */
  kind?: string;
  /** A path prefix (`src/support`) or a glob (`src/**\/*.ts`). */
  path?: string;
  /** Include members (methods, properties) too, not only files and top-level symbols. */
  nested?: boolean;
}

export const UNASSIGNED_KINDS: readonly string[] = ['file', 'symbol', ...SYMBOL_KINDS];

/**
 * Elements in no non-overlay layer that a dependency can involve, within `scope.include` and
 * `scope.exclude`: symbols (top-level ones unless `nested`), and files that declare a symbol or
 * are an end of an evaluated edge. A file nothing can depend on through a scoped edge type
 * (AGENTS.md, a JSON config) is not listed, as `mapx check` never reports it uncovered. Overlays
 * do not assign. An unknown `kind`, or a `path` that matches no indexed file, is an
 * IntrospectError: a typo must not pass the gate.
 */
export function unassignedElements(ctx: ArchContext, options: UnassignedOptions = {}): { total: number; elements: ElementRef[] } {
  if (options.kind !== undefined && !UNASSIGNED_KINDS.includes(options.kind)) {
    throw new IntrospectError(`--kind "${options.kind}" is not file, symbol or a symbol kind (${SYMBOL_KINDS.join(', ')})`, [...UNASSIGNED_KINDS]);
  }
  const view = ctx.membership.view;
  let pathOk = (_: string) => true;
  if (options.path !== undefined) {
    const p = workspacePath(ctx.dir, options.path);
    pathOk = /[*?[{]/.test(p) || p.startsWith('/') ? globOrRegex(p) : (s) => p === '' || s === p || s.startsWith(`${p}/`);
    if (![...view.files.keys()].some(pathOk)) throw new IntrospectError(`--path "${options.path}" matches no indexed file`);
  }
  const ends = ctx.evaluation().endFiles;
  const withSymbols = new Set(view.elements.filter((e) => e.kind === 'symbol').map((e) => e.file.path));
  const dependable = (e: Element) => e.kind === 'symbol' || withSymbols.has(e.file.path) || ends.has(e.file.path);
  const kindOk = (e: Element) => !options.kind || options.kind === e.kind || options.kind === e.symbolKind;
  const elements = view.elements
    .filter((e) => listed(e, !!options.nested) && kindOk(e) && dependable(e) && ctx.scope.path(e.file.path) && pathOk(e.file.path) && !ctx.membership.primaryOf(e).length)
    .sort(byFile).map(elementRef);
  return { total: elements.length, elements };
}

// ─── AR-13d: layer dependencies ───────────────────────────────────────────────────────────────

export interface ConcreteDependency {
  /** The finest elements the edge names: a method, or a file for an import. */
  source: ElementRef & { line?: number };
  target: ElementRef;
  /** The target's non-overlay layers (for a Go package import, its files'). */
  targetLayers: string[];
  edgeType: string;
  verifiability: 'verified' | 'inferred';
  /** What `mapx check` decides for it (before any baseline). */
  kind: 'violation' | 'uncovered' | 'allowed';
  rule?: string;
  severity: FindingSeverity;
  violatedLayers?: string[];
}

/**
 * The stored edges from layer `from` to layer `to` (every other layer, and no layer, when `to` is
 * omitted), each with its file and line, edge type, verifiability and decision. Edges within one
 * layer are never decided, so `from` = `to` lists nothing.
 */
export function layerDependencies(ctx: ArchContext, from: string, to?: string): {
  from: string; to: string | null; counts: { allowed: number; violation: number; uncovered: number }; dependencies: ConcreteDependency[];
} {
  requireLayer(ctx, from);
  if (to !== undefined) requireLayer(ctx, to);
  const deps = ctx.evaluation().dependencies
    // A pair counts for each other layer of the target, as in the report's layerEdges: an edge into
    // an element in both Domain and Shared is a Domain → Shared edge, never Domain → Domain.
    .filter((d) => d.sourceLayer === from && (to === undefined || (to !== from && (d.targetLayers.includes(to) || !!d.violatedLayers?.includes(to)))))
    .map((d): ConcreteDependency => ({
      source: { ...elementRef(d.source), ...(d.line !== undefined ? { line: d.line } : {}) },
      target: d.targetPackage ? { element: d.targetPackage.name, kind: 'file', file: d.targetPackage.dir } : elementRef(d.target),
      targetLayers: d.targetLayers, edgeType: d.edgeType, verifiability: d.verifiability, kind: d.kind,
      ...(d.rule ? { rule: d.rule } : {}), severity: d.severity, ...(d.violatedLayers ? { violatedLayers: d.violatedLayers } : {}),
    }));
  const key = (d: ConcreteDependency) => [d.source.file, String(d.source.line ?? 0).padStart(9, '0'), d.source.element, d.target.element, d.edgeType].join('\u0000');
  deps.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const counts = { allowed: 0, violation: 0, uncovered: 0 };
  for (const d of deps) counts[d.kind]++;
  return { from, to: to ?? null, counts, dependencies: deps };
}

// ─── AR-13e: unused allowances ────────────────────────────────────────────────────────────────

export interface AllowanceUse {
  from: string;
  to: string;
  /** How the policy grants the pair: `explicit`, `+L` (inherited through that "+"), `*`. */
  rule: string;
  /** The edge types the grant covers; null for every type in scope. */
  types: string[] | null;
  /** `warn` for an advisory allowance. */
  severity: 'error' | 'warn';
  /** Stored edges the allowance decides: allowed ones, and the warnings an advisory one reports. */
  uses: number;
}

/**
 * Every allowance of the expanded policy (AR-05) used at most `limit` times (default 0: the dead
 * ones), in configuration order. A use is a stored edge the allowance decides: an allowed
 * dependency on that layer, or a warning an advisory allowance reports.
 */
export function unusedAllowances(ctx: ArchContext, options: { limit?: number } = {}): { limit: number; total: number; allowances: AllowanceUse[] } {
  const limit = options.limit ?? 0;
  const uses = new Map<string, number>();
  const bump = (from: string, to: string) => uses.set(`${from}\u0000${to}`, (uses.get(`${from}\u0000${to}`) ?? 0) + 1);
  for (const d of ctx.evaluation().dependencies) {
    if (d.kind === 'allowed') for (const t of d.targetLayers) { if (t !== d.sourceLayer) bump(d.sourceLayer, t); }
    else if (d.kind === 'violation' && d.rule === 'disallowed-layer') {
      // An advisory allowance is used by the warnings it turns violations into.
      for (const t of d.violatedLayers ?? []) {
        const r = decide(ctx.policy, d.sourceLayer, t, d.edgeType);
        if (!r.allowed && r.advisory) bump(d.sourceLayer, t);
      }
    }
  }
  const order = layerOrder(ctx);
  const all: AllowanceUse[] = [];
  for (const from of [...ctx.policy.allowed.keys()].sort(order)) {
    for (const [to, grants] of [...ctx.policy.allowed.get(from)!].sort((a, b) => order(a[0], b[0]))) {
      const types = grants.some((g) => !g.types) ? null : [...new Set(grants.flatMap((g) => [...g.types!]))].sort();
      all.push({
        from, to, rule: [...new Set(grants.map((g) => g.via))].join(', '), types,
        severity: grants.every((g) => g.advisory) ? 'warn' : 'error', uses: uses.get(`${from}\u0000${to}`) ?? 0,
      });
    }
  }
  return { limit, total: all.length, allowances: all.filter((a) => a.uses <= limit) };
}

// ─── AR-13f: changed files ────────────────────────────────────────────────────────────────────

export interface ChangedLayers {
  /** `inScope`: `scope.include`/`scope.exclude` admit the file; only in-scope files touch layers. */
  files: Array<{ file: string; indexed: boolean; inScope: boolean; layers: string[] }>;
  /** Every non-overlay layer the in-scope files are in, in configuration order. */
  layers: string[];
  /** With `withDependents`: the other files with an evaluated edge into these, by their layers. */
  dependents?: Array<{ layer: string; files: string[] }>;
  /** With `withDependents`: dependent files in no layer. */
  unassignedDependents?: string[];
}

/**
 * The layers `files` touch, from the index as it is (no re-scan: a file it does not have is listed
 * with `indexed: false`). With `withDependents`, the layers of the files that depend on them
 * directly: an edge `mapx check` evaluates (its type in `scope.types`, both ends in the scope's
 * paths, not an inferred edge under `policy.inferred: "ignore"`) from another file into one of them.
 */
export function changedLayers(ctx: ArchContext, files: string[], options: { withDependents?: boolean } = {}): ChangedLayers {
  const m = ctx.membership;
  const order = layerOrder(ctx);
  const paths = [...new Set(files.map((f) => workspacePath(ctx.dir, f)))].sort();
  const out: ChangedLayers = {
    files: paths.map((file) => {
      const el = m.view.byId.get(`file:${file}`);
      const inScope = ctx.scope.path(file);
      return { file, indexed: !!el, inScope, layers: el ? m.primaryOf(el) : [] };
    }),
    layers: [],
  };
  out.layers = [...new Set(out.files.filter((f) => f.inScope).flatMap((f) => f.layers))].sort(order);
  if (!options.withDependents) return out;
  const changed = new Set(paths.filter((p) => ctx.scope.path(p)));
  const sources = new Set<string>();
  const rows = ctx.store.raw.prepare('SELECT DISTINCT source_file, target_file, edge_type, verifiability FROM edges').all() as Array<{ source_file: string; target_file: string; edge_type: string; verifiability: string | null }>;
  for (const r of rows) {
    if (!changed.has(r.target_file) || changed.has(r.source_file) || !ctx.scope.types.has(r.edge_type) || !ctx.scope.path(r.source_file)) continue;
    if (!ctx.scope.verifiability(r.verifiability === 'inferred' ? 'inferred' : 'verified')) continue;
    sources.add(r.source_file);
  }
  const byLayer = new Map<string, string[]>();
  const unassigned: string[] = [];
  for (const file of [...sources].sort()) {
    const layers = m.view.byId.has(`file:${file}`) ? m.primaryOf(`file:${file}`) : [];
    if (!layers.length) unassigned.push(file);
    for (const l of layers) { const list = byLayer.get(l); if (list) list.push(file); else byLayer.set(l, [file]); }
  }
  out.dependents = [...byLayer.keys()].sort(order).map((layer) => ({ layer, files: byLayer.get(layer)! }));
  out.unassignedDependents = unassigned;
  return out;
}

/**
 * The files changed since `ref` (AR-13f `--since`): committed since it, staged, unstaged and
 * untracked, from git alone (no re-scan), as workspace-relative paths. A rename counts both paths.
 * Git is asked in the workspace folder and in every registered repo inside it, each that is a git
 * repository with `ref`; a workspace whose root is no repository works through its repos. It is an
 * IntrospectError only when none of them is a git repository, or none has `ref`.
 */
export function changedSince(dir: string, ref: string, repoPaths: Record<string, string> = {}): string[] {
  const hasRef = (root: string) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const out = new Set<string>();
  // '' is the workspace folder; a peer repo outside the workspace (`../x`) has no workspace paths.
  const roots = [...new Set(['', ...Object.values(repoPaths).map((p) => workspacePath(dir, resolve(dir, p)))])].filter((p) => !p.startsWith('..'));
  let repos = 0;
  let withRef = 0;
  for (const prefix of roots) {
    const root = resolve(dir, prefix);
    if (!isGitRepo(root)) continue;
    repos++;
    if (!hasRef(root)) continue;
    withRef++;
    for (const c of getChangedFiles(root, ref)) {
      for (const p of [c.path, c.oldPath]) if (p && !p.endsWith('/')) out.add(prefix ? `${prefix}/${p}` : p);
    }
  }
  if (!repos) throw new IntrospectError(`--since needs a git repository: neither ${dir} nor a registered repo is in one`);
  if (!withRef) throw new IntrospectError(`--since: "${ref}" is not a commit of ${repos > 1 ? 'any repo of the workspace' : 'the repository'}`);
  // MapX's own folder (the index, the configuration, baselines) is never source.
  return [...out].filter((p) => !p.split('/').includes('.mapx')).sort();
}

// ─── AR-13g: allowed ──────────────────────────────────────────────────────────────────────────

export type AllowedRule = 'allowed' | 'same-layer' | 'uncovered' | 'overlay' | 'unassigned-source' | 'out-of-scope' | 'disallowed-layer' | 'private-layer';

export interface AllowedEnd {
  query: string;
  kind: 'layer' | 'file' | 'symbol';
  element?: string;
  file?: string;
  /** Non-overlay layers (a layer query: the layer itself, unless it is an overlay). */
  layers: string[];
  overlays: string[];
  /** Layers the element is private to (targets only). */
  private: string[];
  /** `scope.include`/`scope.exclude` admit its file (a layer is always in scope). */
  inScope: boolean;
}

/** One decision, for one edge type and one source layer, as `mapx check` makes it. */
export interface AllowedDecision {
  /** Null only when no edge type is involved (an unassigned source, an end outside the scope's paths). */
  edgeType: string | null;
  /** The index already has such an edge: this is the evaluator's decision on it, verifiability included. */
  observed: boolean;
  /** Null when no edge type is involved; `verified` for a dependency the index does not have. */
  verifiability: 'verified' | 'inferred' | null;
  /** The source layer decided; null when none is (an unassigned source, out of scope). */
  sourceLayer: string | null;
  allowed: boolean;
  rule: AllowedRule;
  severity: FindingSeverity;
  /** For an allowed decision: how the policy grants it (`explicit`, `+L`, `*`). */
  via?: string[];
  violatedLayers?: string[];
  reason: string;
}

export interface AllowedAnswer {
  from: AllowedEnd;
  to: AllowedEnd;
  /** `--type`, or null: every edge type the decisions cover (see isAllowed). */
  edgeType: string | null;
  /** No decision is a violation, of any severity. */
  allowed: boolean;
  /** The strictest decision's: by severity (error, warn, info), then a violation before anything else. */
  rule: AllowedRule;
  severity: FindingSeverity;
  reason: string;
  /** What `mapx check` exits with on it: 1 for an error-level violation, else 0. */
  exitCode: 0 | 1;
  decisions: AllowedDecision[];
  /** The edge types decided without any violation. */
  allowedTypes: string[];
  /** Layers every source layer may depend on (full, non-advisory grants, for `--type`): where to look instead. */
  allowedLayers: string[];
}

function end(ctx: ArchContext, query: string, role: 'source' | 'target'): { end: AllowedEnd; element: Element | null } {
  const layer = ctx.config.layers.find((l) => l.name === query);
  if (layer) {
    if (role === 'source' && layer.overlay) throw new IntrospectError(`"${query}" is an overlay layer: overlays are never dependency sources`);
    return { end: { query, kind: 'layer', layers: layer.overlay ? [] : [query], overlays: layer.overlay ? [query] : [], private: [], inScope: true }, element: null };
  }
  const el = resolveElement(ctx, query);
  const all = ctx.membership.of(el);
  const primary = ctx.membership.primaryOf(el);
  return {
    end: {
      query, kind: el.kind, element: elementName(el), file: el.file.path, layers: primary,
      overlays: all.filter((l) => !primary.includes(l)), private: role === 'target' ? ctx.membership.privateIn(el) : [], inScope: ctx.scope.path(el.file.path),
    },
    element: el,
  };
}

/**
 * The evaluated dependencies between two elements, attributed as `mapx check` attributes them: a
 * file stands for every element it declares, a top-level symbol for its members (findings name
 * the top-level declaration), a member for itself. A Go package import counts for its files.
 */
function observedDependencies(ctx: ArchContext, source: Element, target: Element): Dependency[] {
  const view = ctx.membership.view;
  const covers = (q: Element, e: Element) => (q.kind === 'file' ? e.file.path === q.file.path : q.topLevel ? e.id === q.id || reportElement(view, e).id === q.id : e.id === q.id);
  return ctx.evaluation().dependencies.filter((d) => covers(source, d.source)
    && (d.targetPackage ? target.kind === 'file' && posix.dirname(target.file.path) === d.targetPackage.dir : covers(target, d.target)));
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 2, warn: 1, info: 0 };
const RULE_RANK: Record<AllowedRule, number> = { 'disallowed-layer': 7, 'private-layer': 6, uncovered: 5, 'unassigned-source': 4, allowed: 3, overlay: 2, 'same-layer': 1, 'out-of-scope': 0 };
const strictness = (d: AllowedDecision) => SEVERITY_RANK[d.severity] * 100 + (d.allowed ? 0 : 10) + RULE_RANK[d.rule];

type Draft = Omit<AllowedDecision, 'reason' | 'via'> & { advisory: boolean; targetLayers: string[] };

/**
 * Would a dependency from `from` to `to` pass `mapx check`? Each end is a layer name or an element
 * (see resolveElements). The decisions are the evaluator's own (decideEdge), one per edge type and
 * source layer:
 * - between two elements the index already connects, the stored edges are decided as they are:
 *   their types (without `edgeType`, every type they have) and their verifiability, so
 *   `policy.inferred` applies;
 * - otherwise the dependency is hypothetical and verified, over `edgeType`, or without one over
 *   every type in `scope.types`.
 * The answer is the strictest decision: an error anywhere is an error (exit 1), as `mapx check`
 * reports it. An end outside the scope's paths, or an edge type outside `scope.types`, is
 * `out-of-scope`; an overlay layer as the target is `overlay` unless a source layer denies it.
 * No baseline applies: the answer is what a check without one reports.
 */
export function isAllowed(ctx: ArchContext, from: string, to: string, options: { edgeType?: string } = {}): AllowedAnswer {
  const { end: source, element: sourceEl } = end(ctx, from, 'source');
  const { end: target, element: targetEl } = end(ctx, to, 'target');
  const edgeType = options.edgeType ?? null;
  const scopeTypes = ctx.config.scope.types as string[];
  const label = (e: AllowedEnd) => (e.kind === 'layer' ? `layer ${e.query}` : e.element!);
  const decisions: AllowedDecision[] = [];
  const whole = (rule: AllowedRule, reason: string) => decisions.push({ edgeType, observed: false, verifiability: null, sourceLayer: null, allowed: true, rule, severity: 'info', reason });
  const seen = new Set<string>();
  const add = ({ advisory, targetLayers, ...d }: Draft) => {
    const key = JSON.stringify([d.edgeType, d.sourceLayer, d.rule, d.severity, d.verifiability, d.violatedLayers ?? []]);
    if (seen.has(key)) return;
    seen.add(key);
    decisions.push({ ...d, ...explain(ctx, d, advisory, targetLayers, target, label(target)) });
  };

  if (edgeType !== null && !ctx.scope.types.has(edgeType)) {
    whole('out-of-scope', `${edgeType} edges are not checked: scope.types is ${scopeTypes.join(', ')}`);
  } else if (!source.inScope || !target.inScope) {
    whole('out-of-scope', `${label(source.inScope ? target : source)} is outside scope.include/scope.exclude: \`mapx check\` evaluates none of its edges`);
  } else if (!source.layers.length) {
    whole('unassigned-source', `${label(source)} is in no layer, so no rule applies to it`);
  } else {
    const observed = sourceEl && targetEl ? observedDependencies(ctx, sourceEl, targetEl) : [];
    const types = edgeType !== null ? [edgeType] : observed.length ? scopeTypes.filter((t) => observed.some((d) => d.edgeType === t)) : scopeTypes;
    const targetSide: TargetLayers = { layers: target.layers, overlays: target.overlays, privateIn: target.private };
    for (const type of types) {
      const stored = observed.filter((d) => d.edgeType === type);
      for (const d of stored) {
        const advisory = d.kind === 'violation' && d.severity === 'warn' && d.rule === 'disallowed-layer'
          && (d.violatedLayers ?? []).every((t) => { const r = decide(ctx.policy, d.sourceLayer, t, type); return !r.allowed && r.advisory; });
        add({
          edgeType: type, observed: true, verifiability: d.verifiability, sourceLayer: d.sourceLayer, allowed: d.kind !== 'violation',
          rule: d.rule ?? 'allowed', severity: d.severity, ...(d.violatedLayers ? { violatedLayers: d.violatedLayers } : {}), advisory, targetLayers: d.targetLayers,
        });
      }
      if (stored.length) continue;
      for (const d of decideEdge(ctx.config, ctx.policy, source.layers, targetSide, type, 'verified')) {
        // An overlay layer as the target decides only where a source layer denies it.
        const overlay = target.kind === 'layer' && target.overlays.length > 0 && d.kind === 'uncovered';
        add({
          edgeType: type, observed: false, verifiability: 'verified', sourceLayer: d.sourceLayer, allowed: d.kind !== 'violation',
          rule: overlay ? 'overlay' : d.rule ?? (d.kind === 'same-layer' ? 'same-layer' : 'allowed'), severity: overlay ? 'info' : d.severity,
          ...(d.violatedLayers ? { violatedLayers: d.violatedLayers } : {}), advisory: !!d.advisory, targetLayers: target.layers,
        });
      }
    }
  }
  const worst = decisions.reduce((a, b) => (strictness(b) > strictness(a) ? b : a));
  const typed = [...new Set(decisions.map((d) => d.edgeType).filter((t): t is string => t !== null))];
  const allowedLayers = source.layers.length
    ? ctx.config.layers.map((l) => l.name).filter((t) => source.layers.every((s) => (ctx.policy.allowed.get(s)?.get(t) ?? []).some((g) => !g.advisory && (!edgeType || !g.types || g.types.has(edgeType)))))
    : [];
  return {
    from: source, to: target, edgeType, allowed: decisions.every((d) => d.allowed), rule: worst.rule, severity: worst.severity, reason: worst.reason,
    exitCode: decisions.some((d) => !d.allowed && d.severity === 'error') ? 1 : 0,
    decisions, allowedTypes: typed.filter((t) => decisions.every((d) => d.edgeType !== t || d.allowed)), allowedLayers,
  };
}

/** The reason of one decision, and for an allowed one the grants. */
function explain(ctx: ArchContext, d: Omit<AllowedDecision, 'reason' | 'via'>, advisory: boolean, targetLayers: string[], target: AllowedEnd, targetLabel: string): { reason: string; via?: string[] } {
  const layer = d.sourceLayer!;
  const type = d.edgeType!;
  const over = `over ${type}${d.verifiability === 'inferred' ? ' (inferred)' : ''}`;
  const violated = d.violatedLayers ?? [];
  const others = targetLayers.filter((t) => t !== layer);
  switch (d.rule) {
    case 'allowed': {
      const via = [...new Set(others.map((t) => decide(ctx.policy, layer, t, type)).flatMap((r) => (r.allowed ? [r.grant.via] : [])))];
      return { reason: `${layer} may depend on ${others.join(', ')} ${over} (${via.join(', ')})`, via };
    }
    case 'same-layer': return { reason: `both are in ${layer}: dependencies within a layer are always allowed` };
    case 'overlay': return { reason: `${target.query} is an overlay layer: it decides only where a source layer denies it ("!${target.query}"), and ${layer} does not` };
    case 'uncovered': return { reason: `${targetLabel} is in no layer: \`mapx check\` reports the dependency as uncovered (warn) and fails on it only with --fail-on-uncovered` };
    case 'private-layer': return { reason: `${targetLabel} is private to ${violated.join(', ')}: only ${violated.length > 1 ? 'those layers' : 'that layer'} may depend on it` };
    default: {
      if (advisory) return { reason: `${layer} on ${violated.join(', ')} ${over} is advisory (severity warn): \`mapx check\` reports it as a warning` };
      const denied = violated.filter((t) => ctx.policy.denied.get(layer)?.has(t));
      const scoped = violated.filter((t) => !denied.includes(t) && ctx.policy.allowed.get(layer)?.has(t));
      const why = [
        ...(denied.length ? [`"!${denied.join('", "!')}" denies it`] : []),
        ...(scoped.length ? [`the allowance of ${scoped.join(', ')} does not cover ${type} edges`] : []),
      ];
      const inferred = d.verifiability === 'inferred' && d.severity === 'warn' ? '; the edge is inferred, and policy.inferred "warn" makes that a warning' : '';
      return { reason: `${layer} may not depend on ${violated.join(', ')} ${over}: ${why.length ? why.join('; ') : 'no rule allows it'}${inferred}` };
    }
  }
}
