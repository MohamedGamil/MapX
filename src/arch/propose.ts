// A proposed architecture configuration from MapX roles (M5-14, for mapx_arch_init; AR-15's first
// two inference steps only): one layer per role the index assigns, selected with `role`, and the
// archetype's LAYER_ORDER turned into "may depend downward" rules. A person reviews it before
// relying on it. M5-17 (`mapx arch init`) adds clusters, frameworks, the observed layer graph,
// presets and a baseline, and can replace this module.
import type { Store } from '../core/store.js';
import { LAYER_ORDER } from '../core/flow-validator.js';
import type { CodebaseArchetype, FileRole } from '../types.js';
import { validateArchitectureText, type ConfigIssue } from './config.js';
import type { ArchitectureDocument } from './schema.js';

export interface Proposal {
  /** The archetype whose layer order the rules follow (`mixed` when the index has no profile). */
  archetype: CodebaseArchetype;
  /** One layer per role, in the archetype's order (top first), with the files the role has. */
  layers: Array<{ name: string; role: string; files: number }>;
  /** Roles the index assigns that the archetype's order does not place (`other`, `test` …): left out. */
  unplaced: Array<{ role: string; files: number }>;
  /** The configuration as JSONC, ready to write to `.mapx/architecture.jsonc`. */
  text: string;
  /** Problems `validateArchitectureText` finds in it: none, unless no role could be placed. */
  issues: ConfigIssue[];
}

const layerName = (role: string) => role.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/** The proposal for the index in `store`; `repo` names the repo whose codebase profile gives the archetype. */
export function proposeFromRoles(store: Store, repo: string): Proposal {
  let archetype: CodebaseArchetype = 'mixed';
  try {
    const profile = JSON.parse(store.getMeta(`codebase_profile:${repo}`) ?? 'null') as { archetype?: CodebaseArchetype } | null;
    if (profile?.archetype && LAYER_ORDER[profile.archetype]) archetype = profile.archetype;
  } catch { /* no usable profile: mixed */ }
  const counts = new Map<string, number>();
  for (const row of store.raw.prepare("SELECT role, COUNT(*) AS n FROM files WHERE role IS NOT NULL AND role <> '' GROUP BY role").all() as Array<{ role: string; n: number }>) {
    counts.set(row.role, row.n);
  }
  const order = LAYER_ORDER[archetype] as FileRole[];
  const placed = order.filter((r) => counts.has(r));
  const layers = placed.map((role) => ({ name: layerName(role), role, files: counts.get(role)! }));
  const unplaced = [...counts.keys()].filter((r) => !placed.includes(r as FileRole)).sort().map((role) => ({ role, files: counts.get(role)! }));
  const doc: ArchitectureDocument = {
    layers: layers.map((l) => ({ name: l.name, selectors: [{ role: l.role }] })),
    // A layer may depend on the layers after it in the archetype's order, as FlowValidator judges.
    rules: Object.fromEntries(layers.map((l, i) => [l.name, layers.slice(i + 1).map((d) => d.name)])),
  };
  const header = [
    `// Proposed by mapx_arch_init from MapX roles and the "${archetype}" layer order (AR-15).`,
    '// Review it before relying on it: rename layers, replace role selectors with paths, tighten rules.',
    ...(unplaced.length ? [`// Roles left out (no place in the order): ${unplaced.map((u) => `${u.role} (${u.files})`).join(', ')}.`] : []),
  ];
  const text = `${header.join('\n')}\n${JSON.stringify(doc, null, 2)}\n`;
  const issues = layers.length
    ? validateArchitectureText(text, '.mapx/architecture.jsonc')
    : [{ file: '.mapx/architecture.jsonc', pointer: '/layers', message: 'no role the index assigns has a place in the layer order: nothing to propose' }];
  return { archetype, layers, unplaced, text, issues };
}
