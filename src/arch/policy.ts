// Policy expansion (M5-04; docs/research/deptrac AR-05). Turns the `rules` of a loaded
// configuration into, per non-overlay source layer, the target layers it may depend on.
//
// Forms: "L" (allow), "+L" (L, and L's own allowances, transitively), "!L" (deny), "*" (every
// non-overlay layer), and the objects {allow: [...], types?, severity?} and {to, types?, severity?}.
// A "*" key holds defaults merged into every source layer's list.
//
// Precedence: ! > explicit > + > *. For one target, only the grants of the strongest form count:
// a source's own allowances (explicit, or the layer a "+" names) beat those it inherits through
// "+", which beat "*". `types` limits a grant to those edge types (inherited grants keep the
// narrower scope). `severity: "warn"` makes a grant advisory: the dependency is reported, as a
// warning, instead of allowed or failing (AR-05 "a whole layer pair can be advisory").
import type { ArchitectureConfig, Allowance } from './schema.js';

export interface Grant {
  /** Edge types the grant covers; undefined means every type in scope. */
  types?: Set<string>;
  /** Advisory (`severity: "warn"`): dependencies are reported as warn-level violations. */
  advisory: boolean;
  /** How the grant arose: `explicit`, `+Service` (inherited through that "+"), or `*`. */
  via: string;
}

export interface ExpandedPolicy {
  /** source layer → target layer → grants of the strongest form. */
  allowed: Map<string, Map<string, Grant[]>>;
  /** source layer → explicitly denied target layers (its own "!L" and the "*" key's). */
  denied: Map<string, Set<string>>;
  /** Problems the loader already rejects (defence in depth): unknown layers, overlay sources. */
  errors: string[];
}

interface Parsed { target: string; mode: 'allow' | 'plus' | 'deny' | 'star'; types?: Set<string>; advisory: boolean }

function parse(a: Allowance): Parsed[] {
  const one = (s: string, types: Set<string> | undefined, advisory: boolean): Parsed => {
    if (s === '*') return { target: '*', mode: 'star', types, advisory };
    if (s.startsWith('!')) return { target: s.slice(1), mode: 'deny', advisory: false };
    if (s.startsWith('+')) return { target: s.slice(1), mode: 'plus', types, advisory };
    return { target: s, mode: 'allow', types, advisory };
  };
  if (typeof a === 'string') return [one(a, undefined, false)];
  const types = a.types?.length ? new Set<string>(a.types) : undefined;
  const advisory = a.severity === 'warn';
  return [...(a.allow ?? []), ...(a.to !== undefined ? [a.to] : [])].map((s) => one(s, types, advisory));
}

const RANK = { explicit: 3, inherited: 2, star: 1 } as const;

/** Expands the rules of `config` (AR-05). */
export function expandPolicy(config: Pick<ArchitectureConfig, 'layers' | 'rules'>): ExpandedPolicy {
  const errors: string[] = [];
  const layerNames = new Set(config.layers.map((l) => l.name));
  const overlays = new Set(config.layers.filter((l) => l.overlay).map((l) => l.name));
  const sources = config.layers.filter((l) => !l.overlay).map((l) => l.name);

  const own = new Map<string, Parsed[]>();
  const defaults = (config.rules['*'] ?? []).flatMap(parse);
  for (const [source, list] of Object.entries(config.rules)) {
    if (source === '*') continue;
    if (!layerNames.has(source)) { errors.push(`rules: unknown source layer "${source}"`); continue; }
    if (overlays.has(source)) { errors.push(`rules: overlay layer "${source}" cannot be a source`); continue; }
    own.set(source, list.flatMap(parse));
  }
  for (const p of [...defaults, ...[...own.values()].flat()]) {
    if (p.target !== '*' && !layerNames.has(p.target)) errors.push(`rules: unknown target layer "${p.target}"`);
  }
  const direct = (layer: string): Parsed[] => [...(own.get(layer) ?? []), ...defaults];

  const allowed = new Map<string, Map<string, Grant[]>>();
  const denied = new Map<string, Set<string>>();
  for (const source of sources) {
    const deny = new Set<string>();
    const best = new Map<string, { rank: number; grants: Grant[] }>();
    const grant = (target: string, rank: number, g: Grant) => {
      if (target === source || !layerNames.has(target)) return;
      const cur = best.get(target);
      if (!cur || rank > cur.rank) best.set(target, { rank, grants: [g] });
      else if (rank === cur.rank) cur.grants.push(g);
    };
    // `from` is the "+" chain that brought `layer`'s allowances (null for the source's own). `path`
    // guards cycles per chain, not globally: every "+" path contributes its own scope and severity,
    // so the result does not depend on rule order (review of M5-04).
    const visit = (layer: string, from: { via: string; types?: Set<string>; advisory: boolean } | null, path: Set<string>) => {
      for (const p of direct(layer)) {
        if (p.mode === 'deny') { if (!from) deny.add(p.target); continue; }
        const types = p.types && from?.types ? new Set([...p.types].filter((t) => from.types!.has(t))) : p.types ?? from?.types;
        const advisory = p.advisory || !!from?.advisory;
        if (p.mode === 'star') {
          for (const t of sources) grant(t, RANK.star, { types, advisory, via: from ? `${from.via} *` : '*' });
          continue;
        }
        const rank = from ? RANK.inherited : RANK.explicit;
        grant(p.target, rank, { types, advisory, via: from ? from.via : p.mode === 'plus' ? `+${p.target}` : 'explicit' });
        if (p.mode === 'plus' && !path.has(p.target) && layerNames.has(p.target)) {
          visit(p.target, { via: from ? from.via : `+${p.target}`, types, advisory }, new Set([...path, p.target]));
        }
      }
    };
    visit(source, null, new Set([source]));
    const map = new Map<string, Grant[]>();
    for (const [target, { grants }] of best) if (!deny.has(target)) map.set(target, grants);
    allowed.set(source, map);
    denied.set(source, deny);
  }
  return { allowed, denied, errors };
}

export type Decision =
  | { allowed: true; grant: Grant }
  | { allowed: false; advisory: boolean; denied: boolean };

/**
 * May `source` depend on `target` over an edge of `type`? A full grant for the type allows it; an
 * advisory one reports it as a warning; no grant (or a deny) is a violation.
 */
export function decide(policy: ExpandedPolicy, source: string, target: string, type: string): Decision {
  if (policy.denied.get(source)?.has(target)) return { allowed: false, advisory: false, denied: true };
  const grants = (policy.allowed.get(source)?.get(target) ?? []).filter((g) => !g.types || g.types.has(type));
  const full = grants.find((g) => !g.advisory);
  if (full) return { allowed: true, grant: full };
  return { allowed: false, advisory: grants.length > 0, denied: false };
}
