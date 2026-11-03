// The rule evaluator (M5-04; docs/research/deptrac AR-06, AR-07, AR-08, AR-12). Walks the stored
// edges, maps each end to its finest element, and decides every dependency by the AR-08 chain:
//
//   1. out of scope (edge type, include/exclude paths, inferred under policy "ignore", self) → ignored
//   2. per non-overlay source layer (AR-12; a source in no layer is ignored):
//      a. the target is in no non-overlay layer           → uncovered
//      b. the source layer is one of the target's layers  → nothing (same layer)
//      c. no target layer is allowed for this edge type   → violation, disallowed-layer
//      d. internal-element                                → not yet (doc tags arrive with M5-10)
//      e. the target is private to another layer          → violation, private-layer
//      f. otherwise                                       → allowed
//
// Findings are reported at the granularity of top-level declarations: a method's dependency is its
// class's, and a file-level edge (an import) belongs to the file's only top-level symbol, so one
// class-to-class dependency carried by an import, a `new` and a call is one dependency per edge type.
// Two exceptions: the target of an `http` or `route` edge stays the handler (the endpoint is the
// dependency), and a Go import names a package, so its target is the package (its directory's
// files' layers), not whichever file of it the edge was stored against.
import { posix } from 'node:path';
import type { Store } from '../core/store.js';
import type { ArchitectureConfig } from './schema.js';
import type { Element, ElementView } from './elements.js';
import type { LayerMembership } from './membership.js';
import { globOrRegex } from './selectors/index.js';
import { decide, type ExpandedPolicy } from './policy.js';

export type FindingKind = 'violation' | 'skipped' | 'uncovered' | 'allowed' | 'warning' | 'error';
export type FindingSeverity = 'error' | 'warn' | 'info';

export interface FindingEnd { element: string; file: string; layer?: string; repo?: string; line?: number }

export interface Finding {
  kind: FindingKind;
  rule?: string;
  severity: FindingSeverity;
  source?: FindingEnd;
  target?: FindingEnd;
  edgeType?: string;
  verifiability?: 'verified' | 'inferred';
  /** Layer-level findings (`empty-layer`, `plus-cycle`) name their layer here. */
  layer?: string;
  /** How many stored edges this finding stands for. */
  edges?: number;
  fingerprint: string;
  /**
   * The fingerprint's inputs where they differ from the shown elements (M5-06): a file-level end is
   * its file path, whatever symbols the file declares, and an end outside the workspace's root
   * repo names its repo (workspace-relative path).
   */
  identity?: { source: string; target: string; sourceRepo?: string; targetRepo?: string };
  /** Why a `skipped` finding is skipped: a baseline entry, or the base report of `--compare` (M5-06). */
  skippedBy?: 'baseline' | 'compare';
  /**
   * Where to fix a finding that is not about code (M5-07 review): a stale baseline entry is in the
   * baseline file (workspace-relative, `/`) at a JSON pointer. CI reporters locate it here.
   */
  location?: { file: string; pointer?: string };
  message: string;
}

interface EdgeRow {
  source_file: string; target_file: string; source_symbol: string | null; target_symbol: string | null;
  edge_type: string; verifiability: string | null; metadata: string | null;
}

/** Resolves an edge end (`file`, stored symbol text) to the finest element of the view. */
export function endResolver(view: ElementView): (file: string, symbol: string | null) => Element | null {
  const index = new Map<string, { byQn: Map<string, Element>; byName: Map<string, Element[]>; byScoped: Map<string, Element> }>();
  const of = (file: string) => {
    let idx = index.get(file);
    if (!idx) {
      idx = { byQn: new Map(), byName: new Map(), byScoped: new Map() };
      for (const e of view.ofFile(file)) {
        if (e.kind !== 'symbol') continue;
        idx.byQn.set(e.qualifiedName, e);
        const list = idx.byName.get(e.name!) ?? [];
        list.push(e);
        idx.byName.set(e.name!, list);
        // `Order::run`, `Order.run`, `Order#run`, and Laravel's `Controller@method` (http and route edges).
        if (e.scope) for (const sep of ['::', '.', '#', '\\', '@']) idx.byScoped.set(`${e.scope}${sep}${e.name}`, e);
      }
      index.set(file, idx);
    }
    return idx;
  };
  return (file, symbol) => {
    const fileEl = view.byId.get(`file:${file}`) ?? null;
    if (!fileEl || !symbol) return fileEl;
    const idx = of(file);
    const hit = idx.byQn.get(symbol) ?? idx.byScoped.get(symbol);
    if (hit) return hit;
    // `App\Http\Controllers\UserController@index`: the method of the class the file declares.
    const at = symbol.lastIndexOf('@');
    if (at > 0) {
      const cls = symbol.slice(0, at).split(/::|\\|\./).pop()!;
      const method = idx.byScoped.get(`${cls}::${symbol.slice(at + 1)}`);
      if (method) return method;
    }
    // An import specifier (`../infra/Repo`, `example.com/shop/domain`) names the file or package,
    // not a symbol, even when a symbol shares its last segment (review of M5-04).
    if (symbol.includes('/')) return fileEl;
    // A trailing name (`App\Domain\Order` stored as `Order`, `pkg.Order`): only when one symbol of
    // the file has it. A method `save` and a function `save` are ambiguous: the file decides.
    const tail = symbol.split(/::|\\|\.|#|@/).pop()!;
    const named = idx.byName.get(tail) ?? [];
    return named.length === 1 ? named[0]! : fileEl;
  };
}

/**
 * The element a finding names for `el`: a symbol's top-level declaration (a method → its class),
 * or for a file its only top-level symbol; otherwise the element itself.
 */
export function reportElement(view: ElementView, el: Element): Element {
  const tops = view.ofFile(el.file.path).filter((e) => e.kind === 'symbol' && e.topLevel);
  if (el.kind === 'file') return tops.length === 1 ? tops[0]! : el;
  if (el.topLevel) return el;
  const owner = tops
    .filter((t) => el.qualifiedName.length > t.qualifiedName.length && el.qualifiedName.startsWith(t.qualifiedName) && /^(::|\.|#|\\)/.test(el.qualifiedName.slice(t.qualifiedName.length)))
    .sort((a, b) => b.qualifiedName.length - a.qualifiedName.length)[0];
  if (owner) return owner;
  const byScope = el.scope ? tops.filter((t) => t.name === el.scope) : [];
  if (byScope.length === 1) return byScope[0]!;
  // A member declared in another file of the type's namespace or package: a Go method in
  // `other.go`, a C# partial class, a Rust `impl` block (review of M5-04).
  if (el.scope && el.file.namespace) {
    const elsewhere = typesOf(view).get(`${el.file.namespace}\u0000${el.scope}`) ?? [];
    if (elsewhere.length === 1) return elsewhere[0]!;
  }
  return el;
}

const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'module']);
const typeIndexes = new WeakMap<ElementView, Map<string, Element[]>>();
/** Top-level types by (namespace, name), across files. */
function typesOf(view: ElementView): Map<string, Element[]> {
  let index = typeIndexes.get(view);
  if (!index) {
    index = new Map();
    for (const e of view.elements) {
      if (e.kind !== 'symbol' || !e.topLevel || !e.file.namespace || !TYPE_KINDS.has(e.symbolKind ?? '')) continue;
      const key = `${e.file.namespace}\u0000${e.name}`;
      index.set(key, [...(index.get(key) ?? []), e]);
    }
    typeIndexes.set(view, index);
  }
  return index;
}

/** The name a finding shows for an element: a symbol's qualified name, a file's path. */
export const elementName = (el: Element) => (el.kind === 'symbol' ? el.qualifiedName : el.file.path);

/** Edge types whose target is an endpoint: the handler method, not its class, is the dependency. */
export const ENDPOINT_EDGES = new Set(['http', 'route']);

/** A package-level target (a Go import): its name and directory. */
export interface PackageEnd { name: string; dir: string }

export interface Dependency {
  kind: 'violation' | 'uncovered' | 'allowed';
  rule?: 'disallowed-layer' | 'private-layer' | 'uncovered';
  severity: FindingSeverity;
  source: Element;
  target: Element;
  sourceLayer: string;
  targetLayers: string[];
  /** For a violation: the target layers the source layer may not depend on. */
  violatedLayers?: string[];
  edgeType: string;
  verifiability: 'verified' | 'inferred';
  line?: number;
  /** Set when the target is a whole package rather than a file or symbol. */
  targetPackage?: PackageEnd;
}

export interface Evaluation {
  /** One decision per (edge, source layer). */
  dependencies: Dependency[];
  /** Files at either end of an evaluated edge, same-layer ones included. */
  endFiles: Set<string>;
}

/** Evaluates every stored edge under `config` (AR-08). */
export function evaluateEdges(store: Store, config: ArchitectureConfig, membership: LayerMembership, policy: ExpandedPolicy): Evaluation {
  const view = membership.view;
  const resolve = endResolver(view);
  const scope = edgeScope(config);
  const inScopePath = scope.path;
  const overlays = new Set(config.layers.filter((l) => l.overlay).map((l) => l.name));
  const packages = new Map<string, string[]>();
  const packageFiles = (dir: string, ns: string): string[] => {
    const key = `${dir}\u0000${ns}`;
    let list = packages.get(key);
    if (!list) {
      list = [...view.files.values()].filter((f) => f.namespace === ns && posix.dirname(f.path) === dir && inScopePath(f.path)).map((f) => f.path);
      packages.set(key, list);
    }
    return list;
  };

  const rows = store.raw.prepare('SELECT source_file, target_file, source_symbol, target_symbol, edge_type, verifiability, metadata FROM edges ORDER BY id').all() as unknown as EdgeRow[];
  const out: Dependency[] = [];
  const endFiles = new Set<string>();
  for (const r of rows) {
    if (!scope.types.has(r.edge_type)) continue;
    const verifiability = r.verifiability === 'inferred' ? 'inferred' : 'verified';
    if (!scope.verifiability(verifiability)) continue;
    if (!inScopePath(r.source_file) || !inScopePath(r.target_file)) continue;
    const source = resolve(r.source_file, r.source_symbol);
    const target = resolve(r.target_file, r.target_symbol);
    if (!source || !target) continue; // an end outside the index (externals: M5-19)
    if (source.id === target.id) continue;
    endFiles.add(source.file.path);
    endFiles.add(target.file.path);
    const sourceLayers = membership.primaryOf(source);
    if (!sourceLayers.length) continue; // the source is in no layer: nothing to check
    // An import of a package (Go stores the package path as the symbol): every file of the package.
    let targetPackage: PackageEnd | undefined;
    let targetLayers = membership.primaryOf(target);
    if (target.kind === 'file' && r.target_symbol && target.file.namespace && r.target_symbol === target.file.namespace) {
      const dir = posix.dirname(target.file.path);
      targetPackage = { name: target.file.namespace, dir };
      const union = new Set<string>();
      for (const f of packageFiles(dir, target.file.namespace)) for (const l of membership.primaryOf(`file:${f}`)) union.add(l);
      targetLayers = config.layers.map((l) => l.name).filter((l) => union.has(l));
    }
    let line: number | undefined;
    try { const m = r.metadata ? JSON.parse(r.metadata) : null; const at = m?.startLine ?? m?.line; if (typeof at === 'number') line = at; } catch { /* no line */ }
    const base = { source, target, targetLayers, edgeType: r.edge_type, verifiability: verifiability as Dependency['verifiability'], line, ...(targetPackage ? { targetPackage } : {}) };
    // Overlays the target is in (Deprecated, Vendor …): they only ever matter as denied targets.
    const targetSide: TargetLayers = { layers: targetLayers, overlays: membership.of(target).filter((l) => overlays.has(l)), privateIn: membership.privateIn(target) };
    for (const d of decideEdge(config, policy, sourceLayers, targetSide, r.edge_type, verifiability)) {
      if (d.kind === 'same-layer') continue;
      out.push({ ...base, kind: d.kind, ...(d.rule ? { rule: d.rule } : {}), severity: d.severity, sourceLayer: d.sourceLayer, ...(d.violatedLayers ? { violatedLayers: d.violatedLayers } : {}) });
    }
  }
  return { dependencies: out, endFiles };
}

/** What a configuration evaluates (AR-06, AR-08 step 1): edge types, paths and inferred edges. */
export interface EdgeScope {
  types: Set<string>;
  /** `scope.include` and `scope.exclude` admit this workspace-relative path. */
  path(p: string): boolean;
  /** An edge of this verifiability is evaluated (inferred ones are not under `policy.inferred: "ignore"`). */
  verifiability(v: 'verified' | 'inferred'): boolean;
}

export function edgeScope(config: Pick<ArchitectureConfig, 'scope' | 'policy'>): EdgeScope {
  const include = config.scope.include.map(globOrRegex);
  const exclude = config.scope.exclude.map(globOrRegex);
  return {
    types: new Set<string>(config.scope.types),
    path: (p) => (!include.length || include.some((m) => m(p))) && !exclude.some((m) => m(p)),
    verifiability: (v) => v === 'verified' || config.policy.inferred !== 'ignore',
  };
}

/** One source layer's decision on an edge, with the severity `mapx check` reports it at. */
export interface EdgeDecision extends LayerDecision { sourceLayer: string; severity: FindingSeverity }

/**
 * The AR-08 decision on an edge of `type` for every source layer, with its severity: uncovered is
 * `warn`, allowed and same-layer `info`, a violation `warn` when only an advisory allowance covers
 * it or the edge is inferred under `policy.inferred: "warn"`, otherwise `error`. The evaluator and
 * `mapx arch allowed` both decide through here, so they cannot disagree.
 */
export function decideEdge(config: Pick<ArchitectureConfig, 'policy'>, policy: ExpandedPolicy, sourceLayers: string[], target: TargetLayers, type: string, verifiability: 'verified' | 'inferred'): EdgeDecision[] {
  return sourceLayers.map((sourceLayer) => {
    const d = decideLayers(policy, sourceLayer, target, type);
    const severity: FindingSeverity = d.kind === 'uncovered' ? 'warn'
      : d.kind === 'allowed' || d.kind === 'same-layer' ? 'info'
        : d.advisory ? 'warn'
          : verifiability === 'inferred' && config.policy.inferred === 'warn' ? 'warn' : 'error';
    return { ...d, sourceLayer, severity };
  });
}

/** The layers of a dependency's target, as the AR-08 chain needs them. */
export interface TargetLayers {
  /** Non-overlay layers (for a package, those of its files). */
  layers: string[];
  /** Overlay layers the target is in. */
  overlays: string[];
  /** Layers whose `private` selectors match the target (AR-07); none for a whole layer. */
  privateIn: string[];
}

/** What AR-08 decides for one source layer (steps 3.1 to 3.6); severity is the caller's. */
export interface LayerDecision {
  kind: 'violation' | 'uncovered' | 'allowed' | 'same-layer';
  rule?: 'disallowed-layer' | 'private-layer' | 'uncovered';
  /** For a violation: the target layers the source layer may not depend on. */
  violatedLayers?: string[];
  /** A disallowed-layer violation every refused layer of which only an advisory grant covers. */
  advisory?: boolean;
}

/**
 * The AR-08 chain for one source layer and edge type: a denied overlay, uncovered, same layer,
 * disallowed layer, private layer, allowed. The evaluator and `mapx arch allowed` share it, so a
 * pre-flight answer is what `mapx check` would report.
 */
export function decideLayers(policy: ExpandedPolicy, sourceLayer: string, target: TargetLayers, type: string): LayerDecision {
  // An overlay the source layer denies (`"*": ["!Deprecated"]`), whatever the target's other
  // layers, the source layer's own included (review of M5-04: overlay denies had no effect).
  const deniedOverlays = target.overlays.filter((l) => policy.denied.get(sourceLayer)?.has(l));
  if (deniedOverlays.length) return { kind: 'violation', rule: 'disallowed-layer', violatedLayers: deniedOverlays, advisory: false };
  if (!target.layers.length) return { kind: 'uncovered', rule: 'uncovered' };
  // AR-08: same layer only when every target layer is the source layer; otherwise each other
  // target layer must be allowed (review of M5-04).
  const others = target.layers.filter((t) => t !== sourceLayer);
  if (!others.length) return { kind: 'same-layer' };
  const refused = others.map((t) => ({ t, d: decide(policy, sourceLayer, t, type) })).filter((x) => !x.d.allowed);
  if (refused.length) {
    const advisory = refused.every((x) => !x.d.allowed && x.d.advisory && !x.d.denied);
    return { kind: 'violation', rule: 'disallowed-layer', violatedLayers: refused.map((x) => x.t), advisory };
  }
  // AR-07: private parts of another layer are reachable only from that layer.
  const privateTo = target.privateIn.filter((l) => l !== sourceLayer);
  if (privateTo.length) return { kind: 'violation', rule: 'private-layer', violatedLayers: privateTo, advisory: false };
  return { kind: 'allowed' };
}
