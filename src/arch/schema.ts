// The architecture configuration document (docs/research/deptrac/02-abstract-feature-model.md AR-11,
// M5-02): `.mapx/architecture.jsonc` and views in `.mapx/architecture/<view>.jsonc`. These types are
// what every later M5 task consumes; `schemas/architecture.schema.json` mirrors them for editors
// (tests/arch-config.test.ts keeps the two in step).
import type { ReferenceType, SymbolKind } from '../types.js';

/** Edge types a rule or scope may name (MapX's ReferenceType). */
export const EDGE_TYPES: readonly ReferenceType[] = [
  'import', 'require', 'extends', 'implements', 'call', 'instantiation', 'return_type', 'param_type',
  'relation', 'route', 'middleware', 'binding', 'dispatch', 'notify', 'hook', 'graphql_resolver',
  'message_handler', 'websocket_handler', 'render', 'http', 'navigate',
];

/** The default dependency scope (AR-06): structural edges; framework edges are opt-in. */
export const DEFAULT_SCOPE_TYPES: readonly ReferenceType[] = ['import', 'require', 'extends', 'implements', 'call', 'instantiation', 'param_type', 'return_type'];

export const SYMBOL_KINDS: readonly SymbolKind[] = ['class', 'method', 'function', 'interface', 'trait', 'constant', 'enum', 'property', 'namespace', 'struct', 'module', 'field', 'variable'];

/** Framework parts a `framework` selector names (AR-04), derived from stored edges. */
export const FRAMEWORK_PARTS = ['route-handler', 'middleware', 'model', 'job', 'event', 'listener', 'resolver', 'component', 'http-client'] as const;

/**
 * Selector keys (AR-04). Each selector object has exactly one primary key; modifiers refine the
 * primary they belong to. `all`, `any` and `not` compose selectors.
 */
export const SELECTOR_PRIMARY_KEYS = [
  'path', 'name', 'extends', 'implements', 'inherits', 'mixes', 'inheritanceDepth', 'decorator', 'docTag',
  'member', 'package', 'builtin', 'ambient', 'role', 'cluster', 'framework', 'repo', 'workspacePackage',
  'language', 'layer', 'all', 'any', 'not',
] as const;
export const SELECTOR_MODIFIERS: Record<string, string> = { kind: 'name', value: 'docTag', dev: 'package', direct: 'package', confidence: 'role' };
export const SELECTOR_KEYS: readonly string[] = [...SELECTOR_PRIMARY_KEYS, ...Object.keys(SELECTOR_MODIFIERS)];

export type SelectorPrimary = typeof SELECTOR_PRIMARY_KEYS[number];

/**
 * A layer selector. Pattern values: `path` is a glob (picomatch) or `/regex/flags`; `name`, `member`
 * and `docTag.value` are regexes (case-insensitive unless `/…/flags` is given); `package` is a glob.
 */
export interface Selector {
  path?: string;
  name?: string;
  kind?: SymbolKind[];
  extends?: string;
  implements?: string;
  inherits?: string;
  mixes?: string;
  inheritanceDepth?: number;
  decorator?: string;
  docTag?: string;
  value?: string;
  member?: string;
  package?: string;
  dev?: boolean;
  direct?: boolean;
  builtin?: boolean | string;
  ambient?: boolean | string;
  role?: string;
  confidence?: number;
  cluster?: string;
  framework?: typeof FRAMEWORK_PARTS[number];
  repo?: string;
  workspacePackage?: string;
  language?: string;
  layer?: string;
  all?: Selector[];
  any?: Selector[];
  not?: Selector;
}

export interface Layer {
  name: string;
  description?: string;
  selectors: Selector[];
  /** Elements these match are reachable only from this layer (AR-07, rule `private-layer`). */
  private?: Selector[];
  /** Only ever a rule target (AR-03): never a source, never counted for `multi-layer` or coverage. */
  overlay?: boolean;
  group?: string;
  color?: string;
}

/**
 * One allowance of a source layer (AR-05): `"L"`, `"+L"` (L's allowances too, transitively), `"!L"`
 * (explicit deny), `"*"` (every non-overlay layer), or an object scoping it to edge types or a severity.
 */
export type Allowance = string | AllowanceObject;
export interface AllowanceObject {
  allow?: string[];
  to?: string;
  types?: ReferenceType[];
  severity?: Severity;
}

export type Severity = 'error' | 'warn';

export interface ArchitectureDocument {
  $schema?: string;
  extends?: string | string[];
  parameters?: Record<string, string>;
  scope?: { types?: ReferenceType[]; include?: string[]; exclude?: string[] };
  policy?: {
    inferred?: 'error' | 'warn' | 'ignore';
    inheritDependencies?: boolean;
    uncovered?: { externals?: boolean; builtins?: boolean };
    strictLayers?: boolean;
  };
  visibility?: { internalTags?: string[]; nativeMarkers?: boolean };
  layers?: Layer[];
  /** Source layer (or `*`, defaults for every layer) → its allowances. */
  rules?: Record<string, Allowance[]>;
  baseline?: string;
  report?: { groups?: Record<string, string[]>; hidden?: string[]; codeclimate?: CodeClimateSeverityMap };
}

/** CodeClimate (GitLab Code Quality) severities, from least to most severe. */
export const CODECLIMATE_SEVERITIES = ['info', 'minor', 'major', 'critical', 'blocker'] as const;
export type CodeClimateSeverity = typeof CODECLIMATE_SEVERITIES[number];
/**
 * What a finding is, for the CodeClimate severity map (M5-07, AR-16): `error` if it fails the run
 * (the exit-code rule), else `uncovered` or `skipped` by kind, else `warn` (other violations, such
 * as advisory rules and inferred edges, and warnings).
 */
export const CODECLIMATE_KEYS = ['error', 'warn', 'uncovered', 'skipped'] as const;
export type CodeClimateSeverityMap = Partial<Record<typeof CODECLIMATE_KEYS[number], CodeClimateSeverity>>;

export const TOP_LEVEL_KEYS = ['$schema', 'extends', 'parameters', 'scope', 'policy', 'visibility', 'layers', 'rules', 'baseline', 'report'] as const;
export const SCOPE_KEYS = ['types', 'include', 'exclude'] as const;
export const POLICY_KEYS = ['inferred', 'inheritDependencies', 'uncovered', 'strictLayers'] as const;
export const UNCOVERED_KEYS = ['externals', 'builtins'] as const;
export const VISIBILITY_KEYS = ['internalTags', 'nativeMarkers'] as const;
export const LAYER_KEYS = ['name', 'description', 'selectors', 'private', 'overlay', 'group', 'color'] as const;
export const ALLOWANCE_KEYS = ['allow', 'to', 'types', 'severity'] as const;
export const REPORT_KEYS = ['groups', 'hidden', 'codeclimate'] as const;

/** The loaded configuration: every document of the `extends` chain merged, parameters applied, defaults filled. */
export interface ArchitectureConfig {
  /** The documents read, the extended ones first, the loaded one last. */
  files: string[];
  view: string | null;
  parameters: Record<string, string>;
  scope: { types: ReferenceType[]; include: string[]; exclude: string[] };
  policy: { inferred: 'error' | 'warn' | 'ignore'; inheritDependencies: boolean; uncovered: { externals: boolean; builtins: boolean }; strictLayers: boolean };
  visibility: { internalTags: string[]; nativeMarkers: boolean };
  layers: Layer[];
  rules: Record<string, Allowance[]>;
  baseline: string | null;
  report: { groups: Record<string, string[]>; hidden: string[]; codeclimate: CodeClimateSeverityMap };
}

export const DEFAULTS = {
  policy: { inferred: 'warn' as const, inheritDependencies: false, uncovered: { externals: true, builtins: false }, strictLayers: false },
  visibility: { internalTags: ['@internal', '@mapx-internal'], nativeMarkers: false },
};
