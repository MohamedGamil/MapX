// Layer membership (M5-03; docs/research/deptrac AR-01 granularity, AR-03, AR-12). Which layers each
// element is in, with the selector that put it there, computed once per (scan, configuration).
//
// Granularity (AR-01): a symbol is in the layers whose selectors match it, file-level selectors
// (path, repo, …) being judged on its file. A file is in the layers whose selectors match the file,
// plus the layers of its top-level symbols, so a `path` layer covers everything under a directory
// and a `name` layer can still single out one class of a multi-class file. Membership never flows
// from one symbol to another.
import { createHash } from 'node:crypto';
import type { Store } from '../core/store.js';
import type { ArchitectureConfig, Layer, Selector } from './schema.js';
import { buildElementView, scanStamp, type Element, type ElementView } from './elements.js';
import { matchSelector, unsupportedKeys, UNSUPPORTED_SELECTORS, type SelectorContext } from './selectors/index.js';

export interface TraceEntry {
  layer: string;
  /** Where in the layer's definition the match was made: `selectors[0].all`, `private[1].path`, … */
  selector: string;
  /** `self`, or the top-level symbol that put a file in the layer. */
  via: string;
  /** A hierarchy match's inheritance path, from the type to the matched ancestor (M5-09). */
  chain?: string[];
}

export interface LayerMembership {
  /** Non-overlay layers, then overlays, in configuration order. */
  layers: Layer[];
  /** Every layer of an element (overlays included). */
  of(element: Element | string): string[];
  /** The non-overlay layers of an element: more than one is the multi-layer warning (AR-12). */
  primaryOf(element: Element | string): string[];
  /** The layers whose `private` selectors match the element (AR-07). */
  privateIn(element: Element | string): string[];
  members(layer: string): Element[];
  explain(element: Element | string): TraceEntry[];
  /** Non-overlay layers no element is in (the empty-layer warning). */
  emptyLayers: string[];
  /** Elements in more than one non-overlay layer. */
  multiLayer: Element[];
  /** Selectors this version cannot evaluate, by layer and position: they match nothing. */
  unsupported: Array<{ layer: string; selector: string; key: string; task: string }>;
  view: ElementView;
}

let computations = 0;
/** How many memberships have been computed in this process (tests check the cache with it). */
export const membershipComputations = () => computations;

/** Computes the membership of every element of `view` under `config`. */
export function computeMembership(view: ElementView, config: Pick<ArchitectureConfig, 'layers'>): LayerMembership {
  computations++;
  const layers = config.layers;
  const byName = new Map(layers.map((l) => [l.name, l]));
  const overlays = new Set(layers.filter((l) => l.overlay).map((l) => l.name));

  // Direct matches, memoised: `${layer}\u0000${element.id}` → trace or null.
  const direct = new Map<string, TraceEntry | null>();
  const evaluating = new Set<string>();
  const ctx: SelectorContext = { view, inLayer: (el, name) => inLayer(el, name) };

  const firstMatch = (selectors: Selector[] | undefined, el: Element, prefix: string): { at: string; chain?: string[] } | null => {
    for (let i = 0; i < (selectors ?? []).length; i++) {
      const m = matchSelector(selectors![i]!, el, ctx);
      if (m.matched) return { at: `${prefix}[${i}].${m.path}`, ...(m.chain ? { chain: m.chain } : {}) };
    }
    return null;
  };

  function directMatch(el: Element, layerName: string): TraceEntry | null {
    const key = `${layerName}\u0000${el.id}`;
    if (direct.has(key)) return direct.get(key)!;
    const layer = byName.get(layerName);
    if (!layer || evaluating.has(key)) return null; // unknown layer, or a cycle (the loader rejects both)
    evaluating.add(key);
    const hit = firstMatch(layer.selectors, el, 'selectors');
    evaluating.delete(key);
    const entry: TraceEntry | null = hit ? { layer: layerName, selector: hit.at, via: 'self', ...(hit.chain ? { chain: hit.chain } : {}) } : null;
    direct.set(key, entry);
    return entry;
  }

  /** Full membership: a file is also in its top-level symbols' layers. */
  function membership(el: Element, layerName: string): TraceEntry | null {
    const own = directMatch(el, layerName);
    if (own || el.kind !== 'file') return own;
    for (const sym of view.ofFile(el.file.path)) {
      if (sym.kind !== 'symbol' || !sym.topLevel) continue;
      const hit = directMatch(sym, layerName);
      if (hit) return { ...hit, via: sym.qualifiedName };
    }
    return null;
  }

  function inLayer(el: Element, layerName: string): boolean {
    return membership(el, layerName) !== null;
  }

  const traces = new Map<string, TraceEntry[]>();
  const privateTraces = new Map<string, string[]>();
  const members = new Map<string, Element[]>(layers.map((l) => [l.name, []]));
  for (const el of view.elements) {
    const entries: TraceEntry[] = [];
    for (const layer of layers) {
      const hit = membership(el, layer.name);
      if (hit) {
        entries.push(hit);
        members.get(layer.name)!.push(el);
      }
    }
    traces.set(el.id, entries);
    const priv: string[] = [];
    for (const layer of layers) {
      if (!layer.private?.length) continue;
      const at = firstMatch(layer.private, el, 'private');
      const viaSymbol = !at && el.kind === 'file'
        ? view.ofFile(el.file.path).some((s) => s.kind === 'symbol' && s.topLevel && firstMatch(layer.private, s, 'private'))
        : false;
      if (at || viaSymbol) priv.push(layer.name);
    }
    if (priv.length) privateTraces.set(el.id, priv);
  }

  const idOf = (e: Element | string) => (typeof e === 'string' ? e : e.id);
  const of = (e: Element | string) => (traces.get(idOf(e)) ?? []).map((t) => t.layer);
  const primaryOf = (e: Element | string) => of(e).filter((l) => !overlays.has(l));

  const unsupported: LayerMembership['unsupported'] = [];
  for (const layer of layers) {
    for (const [section, list] of [['selectors', layer.selectors], ['private', layer.private ?? []]] as const) {
      list.forEach((s, i) => {
        for (const key of unsupportedKeys(s)) unsupported.push({ layer: layer.name, selector: `${section}[${i}]`, key, task: UNSUPPORTED_SELECTORS[key]! });
      });
    }
  }

  return {
    layers,
    of,
    primaryOf,
    privateIn: (e) => privateTraces.get(idOf(e)) ?? [],
    members: (l) => members.get(l) ?? [],
    explain: (e) => traces.get(idOf(e)) ?? [],
    emptyLayers: layers.filter((l) => !l.overlay && members.get(l.name)!.length === 0).map((l) => l.name),
    multiLayer: view.elements.filter((e) => primaryOf(e).length > 1),
    unsupported,
    view,
  };
}

/** What membership depends on in a configuration: the layers (parameters are already substituted). */
export function configHash(config: Pick<ArchitectureConfig, 'layers'>): string {
  return createHash('sha256').update(JSON.stringify(config.layers)).digest('hex').slice(0, 16);
}

const views = new Map<string, { stamp: string; view: ElementView }>();
const cache = new Map<string, LayerMembership>();
const CACHE_LIMIT = 8;

/**
 * The membership for the index in `store` and `config`, computed once per (scan, configuration):
 * the element view is rebuilt when the scan changes, and the membership when either changes.
 * `key` distinguishes indexes (the database path).
 */
export function getMembership(store: Store, dir: string, config: Pick<ArchitectureConfig, 'layers'>, key: string, repoPaths: Record<string, string> = {}): LayerMembership {
  const stamp = scanStamp(store);
  let cached = views.get(key);
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, view: buildElementView(store, dir, repoPaths) };
    views.set(key, cached);
  }
  const cacheKey = `${key}\u0000${stamp}\u0000${configHash(config)}`;
  let membership = cache.get(cacheKey);
  if (!membership) {
    membership = computeMembership(cached.view, config);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, membership);
  }
  return membership;
}
