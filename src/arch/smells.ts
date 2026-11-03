// Rule-derived architecture smells (M5-16; docs/research/deptrac AR-18 and §3.3 of the integration
// design). With `.mapx/architecture.jsonc`, `mapx_smells` and `mapx arch` take their layer
// violations from the rule evaluator, the one source of truth, and gain the smells the rules make
// possible. src/core/architecture-analyzer.ts (`currentSmells`) merges them with the stored ones.
//
//   architecture-config        an error that makes `mapx check` exit 3 (a stale baseline entry …)
//   layer-violation            a violation of the report (after the baseline), per source → target file
//   layer-cycle                a strongly connected component of the observed layer graph
//   layer-skip                 in a strictly ordered "+" chain (each layer's one "+" names the next
//                              one down), an allowed dependency on a layer further down than the
//                              next, past non-empty layers (Controller → Repository past Service)
//   dead-allowance             an allowance the rules write for the pair (explicit, or the layer a "+"
//                              names) that no dependency uses, counted as `mapx arch unused` counts;
//                              a "*" default is dead only when no layer uses it, and reported once
//   weak-allowance             the same, used by 1 to WEAK_ALLOWANCE_USES stored edges
//   unstable-layer-dependency  I(source) < I(target) on an observed pair (Martin's Stable
//                              Dependencies Principle, per layer)
//   abstractness-distance      D = |A + I − 1| > DISTANCE_THRESHOLD for a coupled layer with types
//   deprecated-usage           an edge in scope into an element tagged @deprecated, or its member
//
// The observed layer graph is the report's, after the baseline: a baselined violation is
// acknowledged debt (baseline-debt is its own concern), so it makes no cycle and no coupling.
// Instability counts files: Ca(L) is the files outside L with a dependency on L, Ce(L) the files of
// L with a dependency outside it, allowed or not. Abstractness is interfaces and traits over the
// layer's top-level types.
import type { ArchSmell } from '../core/architecture-analyzer.js';
import { shortestCycleThrough, stronglyConnectedComponents } from '../core/architecture-analyzer.js';
import type { ArchContext } from './introspect.js';
import { unusedAllowances } from './introspect.js';
import type { ArchReport, Finding } from './report.js';
import type { Allowance } from './schema.js';
import { CONFIG_RULES } from './check.js';
import { elementName, endResolver, reportElement } from './evaluate.js';
import { hasDocTag } from './selectors/doc-tag.js';
import type { Element } from './elements.js';

/** A rule-derived smell and the repo it belongs to (null: the workspace's, a layer-level smell). */
export interface RuleSmell extends ArchSmell { source: 'rules'; repo: string | null }

/** An allowance used by at most this many stored edges (and at least one) is weak. */
export const WEAK_ALLOWANCE_USES = 2;
/** A layer further than this from the main sequence is an abstractness-distance smell. */
export const DISTANCE_THRESHOLD = 0.7;

/** Rule-derived smell types, in the order they are listed. */
export const RULE_SMELL_TYPES = [
  'architecture-config', 'layer-violation', 'layer-cycle', 'layer-skip', 'dead-allowance', 'weak-allowance',
  'unstable-layer-dependency', 'abstractness-distance', 'deprecated-usage',
] as const;

const TYPE_KINDS = new Set(['class', 'interface', 'trait', 'struct', 'enum']);
const ABSTRACT_KINDS = new Set(['interface', 'trait']);
const CONFIG_FILE = '.mapx/architecture.jsonc';

/**
 * The AR-18 smells of the configuration in `ctx`, given its report (`buildReport` over
 * `ctx.evaluation()`, baseline applied).
 */
export function ruleSmells(ctx: ArchContext, report: ArchReport): RuleSmell[] {
  const smells = [
    ...configErrorSmells(report),
    ...violationSmells(report),
    ...layerGraphSmells(ctx, report),
    ...layerSkipSmells(ctx),
    ...allowanceSmells(ctx),
    ...deprecatedUsageSmells(ctx),
  ];
  const order = new Map<string, number>(RULE_SMELL_TYPES.map((t, i) => [t, i]));
  return smells.sort((a, b) => (order.get(a.type)! - order.get(b.type)!) || (a.description < b.description ? -1 : a.description > b.description ? 1 : 0));
}

const smell = (s: Omit<RuleSmell, 'source'>): RuleSmell => ({ ...s, source: 'rules' });

// ─── architecture-config ──────────────────────────────────────────────────────────────────────

/** The report's errors that make `mapx check` exit 3: a stale baseline entry, a `+` cycle … */
function configErrorSmells(report: ArchReport): RuleSmell[] {
  return report.findings.filter((f) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '')).map((f) => smell({
    type: 'architecture-config',
    severity: 'critical',
    description: f.rule === 'stale-baseline' ? `Stale baseline entry: ${f.message}` : `The architecture configuration has an error: ${f.message}`,
    involvedFiles: f.location ? [f.location.file] : [],
    suggestion: f.rule === 'stale-baseline'
      ? 'Delete the entry, or regenerate the baseline with `mapx check --generate-baseline`; until then `mapx check` exits 3.'
      : 'Fix the configuration (`mapx arch validate-config` lists every problem); until then `mapx check` exits 3.',
    repo: null,
  }));
}

// ─── layer-violation ──────────────────────────────────────────────────────────────────────────

/** One smell per source file → target file: the role-order heuristic reports per file pair too. */
function violationSmells(report: ArchReport): RuleSmell[] {
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    if (f.kind !== 'violation' || !f.source || !f.target) continue;
    const key = JSON.stringify([f.source.repo ?? null, f.source.file, f.target.file]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((fs) => {
    const first = fs[0]!;
    // One line per finding message (an element pair and rule), with the edge types that carry it.
    const lines = new Map<string, string[]>();
    for (const f of fs) {
      const key = `${f.message} [${f.rule}`;
      lines.set(key, [...(lines.get(key) ?? []), f.edgeType ?? '']);
    }
    const rule = first.rule ?? 'disallowed-layer';
    const target = first.message.match(/\(([^()]*) on ([^()]*)\)$/);
    const [srcLayer, tgtLayer] = target ? [target[1]!, target[2]!] : [first.source!.layer ?? '', first.target!.layer ?? ''];
    return smell({
      type: 'layer-violation',
      severity: fs.some((f) => f.severity === 'error') ? 'critical' : 'warning',
      description: `Layer violation: ${[...lines].map(([k, types]) => `${k}: ${[...new Set(types)].join(', ')}]`).join('; ')}`,
      involvedFiles: [first.source!.file, first.target!.file],
      suggestion: rule === 'private-layer'
        ? `Depend on what ${tgtLayer} exposes, not on its private elements.`
        : rule === 'internal-element'
          ? `Use ${tgtLayer}'s public API: the target is internal to it.`
          : `Remove the dependency, or allow ${srcLayer} → ${tgtLayer} in ${CONFIG_FILE} if it is intended (\`mapx arch allowed\` explains the decision).`,
      repo: first.source!.repo ?? null,
    });
  });
}

// ─── The observed layer graph: cycles, stability, distance ───────────────────────────────────

interface LayerGraph {
  /** Observed pairs, source layer → target layers, in configuration order. */
  adj: Map<string, string[]>;
  instability: Map<string, number>;
  /** Ca + Ce per layer. */
  coupling: Map<string, number>;
}

/** Layers as findings name them (`A, B`), as `mapx check --layer` splits them. */
const layersOf = (s: string | undefined) => (s ? s.split(', ') : []);

/**
 * The layer graph of the report after its baseline: pairs with an allowed or a reported violating
 * dependency (`layerEdges`), and per layer the files coupling it to others.
 */
function layerGraph(ctx: ArchContext, report: ArchReport): LayerGraph {
  const names = ctx.config.layers.filter((l) => !l.overlay).map((l) => l.name);
  const known = new Set(names);
  const pairs = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const e of report.layerEdges) if (e.allowed + e.violations > 0 && known.has(e.from) && known.has(e.to)) pairs.get(e.from)!.add(e.to);
  const ca = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  const ce = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const f of report.findings) {
    if ((f.kind !== 'allowed' && f.kind !== 'violation') || !f.source || !f.target) continue;
    for (const s of layersOf(f.source.layer)) {
      for (const t of layersOf(f.target.layer)) {
        if (s === t || !pairs.get(s)?.has(t)) continue;
        ce.get(s)!.add(f.source.file);
        ca.get(t)!.add(f.source.file);
      }
    }
  }
  const order = new Map(names.map((n, i) => [n, i]));
  const adj = new Map(names.map((n) => [n, [...pairs.get(n)!].sort((a, b) => order.get(a)! - order.get(b)!)]));
  const instability = new Map<string, number>();
  const coupling = new Map<string, number>();
  for (const n of names) {
    const a = ca.get(n)!.size, e = ce.get(n)!.size;
    instability.set(n, a + e > 0 ? e / (a + e) : 0);
    coupling.set(n, a + e);
  }
  return { adj, instability, coupling };
}

function layerGraphSmells(ctx: ArchContext, report: ArchReport): RuleSmell[] {
  const g = layerGraph(ctx, report);
  const names = [...g.adj.keys()];
  const out: RuleSmell[] = [];

  for (const scc of stronglyConnectedComponents(g.adj, names).filter((c) => c.length > 1)) {
    const members = new Set(scc);
    const first = names.find((n) => members.has(n))!;
    const path = shortestCycleThrough(first, g.adj, members) ?? [...scc, scc[0]!];
    out.push(smell({
      type: 'layer-cycle',
      severity: 'critical',
      description: `Layer cycle: ${path.join(' -> ')}`,
      involvedFiles: [],
      involvedLayers: names.filter((n) => members.has(n)),
      suggestion: `Break the cycle: invert one of its dependencies (an interface in the lower layer) or merge the layers. \`mapx arch deps <from> <to>\` lists each pair's dependencies.`,
      repo: null,
    }));
  }

  const i = (n: string) => g.instability.get(n)!.toFixed(2);
  for (const [from, tos] of g.adj) {
    for (const to of tos) {
      if (!(g.instability.get(from)! < g.instability.get(to)!)) continue;
      out.push(smell({
        type: 'unstable-layer-dependency',
        severity: 'warning',
        description: `Unstable layer dependency: ${from} (instability ${i(from)}) depends on ${to} (instability ${i(to)}), which is less stable`,
        involvedFiles: [],
        involvedLayers: [from, to],
        suggestion: `Let ${from} depend on abstractions, or move what it needs from ${to} into a more stable layer.`,
        repo: null,
      }));
    }
  }

  for (const n of names) {
    const types = ctx.membership.members(n).filter((e) => e.kind === 'symbol' && e.topLevel && TYPE_KINDS.has(e.symbolKind ?? ''));
    if (!types.length || !g.coupling.get(n)) continue;
    const a = types.filter((e) => ABSTRACT_KINDS.has(e.symbolKind!)).length / types.length;
    const inst = g.instability.get(n)!;
    const d = Math.abs(a + inst - 1);
    if (!(d > DISTANCE_THRESHOLD)) continue;
    const pain = a + inst < 1;
    out.push(smell({
      type: 'abstractness-distance',
      severity: 'info',
      description: `Distance from the main sequence: layer ${n} has D = ${d.toFixed(2)} (abstractness ${a.toFixed(2)}, instability ${inst.toFixed(2)}), ${pain ? 'concrete and stable (zone of pain)' : 'abstract and unstable (zone of uselessness)'}`,
      involvedFiles: [],
      involvedLayers: [n],
      suggestion: pain ? `Add abstractions to ${n} for its dependents, or reduce how much depends on it.` : `Remove abstractions of ${n} nothing implements or uses, or let other layers depend on them.`,
      repo: null,
    }));
  }
  return out;
}

// ─── What the rules write ─────────────────────────────────────────────────────────────────────

/** The targets an allowance list names (`L`, `+L`, `{allow, to}`), denials and `*` aside. */
function namedTargets(list: Allowance[] | undefined, plusOnly = false): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    for (const s of typeof a === 'string' ? [a] : [...(a.allow ?? []), ...(a.to !== undefined ? [a.to] : [])]) {
      if (s === '*' || s.startsWith('!') || (plusOnly && !s.startsWith('+'))) continue;
      out.push(s.replace(/^\+/, ''));
    }
  }
  return out;
}

/**
 * The strictly ordered chain below `layer`: the layer its one `+` names, then that layer's one `+`
 * target, and so on (a layer with no `+`, or several, ends it).
 */
function plusChain(ctx: ArchContext, layer: string): string[] {
  const chain: string[] = [];
  const seen = new Set([layer]);
  for (let at = layer; ;) {
    const next = [...new Set(namedTargets(ctx.config.rules[at], true))];
    if (next.length !== 1 || seen.has(next[0]!)) return chain;
    at = next[0]!;
    seen.add(at);
    chain.push(at);
  }
}

// ─── layer-skip ───────────────────────────────────────────────────────────────────────────────

/**
 * AR-18: "in a strictly ordered preset, a layer bypasses the next one down". A strict order is a
 * `+` chain (`Controller: ["+Service"]`, `Service: ["+Repository"]`). A dependency on a layer of the
 * source's chain past its next one skips the non-empty layers between. A layer the source's own
 * rules or the `*` defaults name, and a layer off the chain (a shared kernel some layer allows
 * plainly, reached through `+`), is never a skip.
 */
function layerSkipSmells(ctx: ArchContext): RuleSmell[] {
  const chains = new Map<string, string[]>();
  const defaults = new Set(namedTargets(ctx.config.rules['*']));
  const groups = new Map<string, RuleSmell>();
  for (const d of ctx.evaluation().dependencies) {
    if (d.kind !== 'allowed') continue;
    let chain = chains.get(d.sourceLayer);
    if (!chain) chains.set(d.sourceLayer, chain = plusChain(ctx, d.sourceLayer));
    const own = new Set(namedTargets(ctx.config.rules[d.sourceLayer]));
    for (const t of d.targetLayers) {
      const k = chain.indexOf(t);
      if (k < 1 || own.has(t) || defaults.has(t)) continue;
      const bypassed = chain.slice(0, k).filter((l) => ctx.membership.members(l).length > 0);
      if (!bypassed.length) continue;
      const src = d.source.file.path, tgt = d.targetPackage ? d.targetPackage.dir : d.target.file.path;
      const key = JSON.stringify([d.sourceLayer, t, src, tgt]);
      if (groups.has(key)) continue;
      groups.set(key, smell({
        type: 'layer-skip',
        severity: 'warning',
        description: `Layer skip: ${src} (${d.sourceLayer}) depends on ${tgt} (${t}), bypassing ${bypassed.join(', ')}`,
        involvedFiles: [src, tgt],
        involvedLayers: [d.sourceLayer, ...bypassed, t],
        suggestion: `Go through ${bypassed[0]}, or allow ${t} explicitly in the rules of ${d.sourceLayer} if it may use it directly.`,
        repo: d.source.file.repo,
      }));
    }
  }
  return [...groups.values()];
}

// ─── dead-allowance, weak-allowance ───────────────────────────────────────────────────────────

/**
 * Allowances the rules write (explicit, or the layer a `+` names; inherited and `*` grants are no
 * rules of their own). A source's own allowance is judged per pair; a `*` default for every source
 * that does not name the target itself, summed: dead only when no layer uses it, reported once.
 */
function allowanceSmells(ctx: ArchContext): RuleSmell[] {
  const out: RuleSmell[] = [];
  const defaults = new Set(namedTargets(ctx.config.rules['*']));
  const byDefault = new Map<string, number>();
  const judge = (from: string, to: string, rule: string, uses: number, layers: string[], tighten: string) => {
    if (uses > WEAK_ALLOWANCE_USES) return;
    out.push(smell(uses === 0
      ? {
        type: 'dead-allowance', severity: 'info',
        description: `Dead allowance: ${from} → ${to} (${rule}) is allowed, but no dependency in scope uses it`,
        involvedFiles: [], involvedLayers: layers, suggestion: tighten, repo: null,
      }
      : {
        type: 'weak-allowance', severity: 'info',
        description: `Weak allowance: ${from} → ${to} (${rule}) is used by only ${uses} edge${uses === 1 ? '' : 's'}`,
        involvedFiles: [], involvedLayers: layers,
        suggestion: `Consider removing the coupling (\`mapx arch deps ${from === '*' ? '<layer>' : from} ${to}\` lists it), then the allowance.`, repo: null,
      }));
  };
  for (const a of unusedAllowances(ctx, { limit: Infinity }).allowances) {
    // A target the source's rules name (`L`, `+L`) is its own allowance, which outranks the grants
    // it inherits or gets from `*`; a target only the defaults name is theirs.
    if (namedTargets(ctx.config.rules[a.from]).includes(a.to)) {
      const rule = `${a.rule}${a.types ? `, ${a.types.join(', ')}` : ''}`;
      judge(a.from, a.to, rule, a.uses, [a.from, a.to], `Tighten the rules of ${a.from} in ${CONFIG_FILE}: it never depends on ${a.to}.`);
    } else if (defaults.has(a.to)) {
      byDefault.set(a.to, (byDefault.get(a.to) ?? 0) + a.uses);
    }
  }
  for (const [to, uses] of byDefault) {
    judge('*', to, 'default for every layer', uses, ['*', to], `Remove ${to} from the "*" defaults in ${CONFIG_FILE}: no layer depends on it.`);
  }
  return out;
}

// ─── deprecated-usage, and the edges the rules decide ─────────────────────────────────────────

interface EdgeRow { source_file: string; target_file: string; source_symbol: string | null; target_symbol: string | null; edge_type: string; verifiability: string | null }

const edgeRows = (ctx: ArchContext) =>
  ctx.store.raw.prepare('SELECT source_file, target_file, source_symbol, target_symbol, edge_type, verifiability FROM edges ORDER BY id').all() as unknown as EdgeRow[];

/**
 * Every edge `mapx check` evaluates (its scope's types, paths and inferred policy), same-layer and
 * unassigned ends included, into a deprecated element or a member of one, from outside it.
 */
function deprecatedUsageSmells(ctx: ArchContext): RuleSmell[] {
  const view = ctx.membership.view;
  const resolve = endResolver(view);
  const deprecated = (el: Element): Element | null => {
    if (el.kind !== 'symbol') return null;
    if (hasDocTag(el, '@deprecated')) return el;
    const owner = reportElement(view, el);
    return owner !== el && owner.kind === 'symbol' && hasDocTag(owner, '@deprecated') ? owner : null;
  };
  const groups = new Map<string, RuleSmell>();
  for (const r of edgeRows(ctx)) {
    if (!ctx.scope.types.has(r.edge_type) || !ctx.scope.verifiability(r.verifiability === 'inferred' ? 'inferred' : 'verified')) continue;
    if (!ctx.scope.path(r.source_file) || !ctx.scope.path(r.target_file)) continue;
    const source = resolve(r.source_file, r.source_symbol);
    const target = resolve(r.target_file, r.target_symbol);
    if (!source || !target) continue;
    const dep = deprecated(target);
    if (!dep) continue;
    const user = reportElement(view, source);
    // Its own members, and deprecated code using deprecated code, are not usages to replace.
    if (user.id === dep.id || deprecated(source) || (user.kind === 'symbol' && hasDocTag(user, '@deprecated'))) continue;
    const key = JSON.stringify([user.id, dep.id]);
    if (groups.has(key)) continue;
    const note = (dep.docTags ?? []).find((t) => /^@?deprecated$/i.test(t.tag.trim()))?.value.trim();
    groups.set(key, smell({
      type: 'deprecated-usage',
      severity: 'warning',
      description: `Deprecated usage: ${elementName(user)} uses ${elementName(dep)}, which is deprecated${note ? ` (${note})` : ''}`,
      involvedFiles: [source.file.path, dep.file.path],
      suggestion: `Replace the use of ${elementName(dep)}${note ? `: ${note}` : ''}.`,
      repo: source.file.repo,
    }));
  }
  return [...groups.values()];
}

/** A source → target file pair, as layer-violation smells name an edge. */
export const edgeKey = (source: string, target: string) => JSON.stringify([source, target]);

/**
 * The file pairs the rules decide, in any way (`policy.alsoInferred` re-reports a role-order
 * violation on no other): an edge whose source is in a layer (allowed, violating, baselined,
 * same-layer, uncovered, or of a type or verifiability the scope leaves out), or which the scope's
 * paths exclude on purpose. What is left is an edge from code no layer covers.
 */
export function ruledEdges(ctx: ArchContext): Set<string> {
  const resolve = endResolver(ctx.membership.view);
  const out = new Set<string>();
  for (const r of edgeRows(ctx)) {
    const key = edgeKey(r.source_file, r.target_file);
    if (out.has(key)) continue;
    if (!ctx.scope.path(r.source_file) || !ctx.scope.path(r.target_file)) { out.add(key); continue; }
    const source = resolve(r.source_file, r.source_symbol);
    if ((source && ctx.membership.primaryOf(source).length) || ctx.membership.primaryOf(`file:${r.source_file}`).length) out.add(key);
  }
  return out;
}
