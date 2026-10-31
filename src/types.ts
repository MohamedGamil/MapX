export interface CodeFile {
  path: string;
  repo: string;
  language: string;
  gitBlobHash: string | null;
  lastScanned: string | null;
  sizeBytes: number;
  lines: number;
  metadata?: Record<string, any>;
}

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  scope: string | null;
  signature: string;
  startLine: number;
  endLine: number;
  metadata: Record<string, unknown>;
}

export type SymbolKind =
  | 'class'
  | 'method'
  | 'function'
  | 'interface'
  | 'trait'
  | 'constant'
  | 'enum'
  | 'property'
  | 'namespace'
  | 'struct'
  | 'module'
  | 'field'
  | 'variable';

export interface ExtractedReference {
  sourceSymbol: string | null;
  targetName: string;
  referenceType: ReferenceType;
  startLine: number;
  verifiability?: 'verified' | 'inferred';
  metadata?: Record<string, any>;
  /** `this.x()` in a Vue Options API component: where `x` may be declared (M3-03). Not stored. */
  vueThis?: VueThisScope;
  /**
   * A PHP function call: the candidate function FQNs in PHP's resolution order (the namespaced
   * name, then the global fallback). Resolves only to `function` symbols (M0-04-R5). Not stored.
   */
  phpFunction?: string[];
  /** A Vuex or Pinia member, resolved in its store file (M3-05). Not stored. */
  vueStore?: VueStoreTarget;
}

/** Edge contract rule 6 (docs/baton/iterations/M3-01.md): the candidates for `this.x()`. */
export interface VueThisScope {
  /** `x` is a member of the component itself (`methods`, `computed`, hooks). */
  own: boolean;
  /** Mixin module specifiers in merge order (`extends` first); null = the component's file. */
  mixins: (string | null)[];
  /** The map helper that introduces `x`. */
  mapped?: VueMappedMember;
}

/** A name spread from `mapActions` / `mapGetters` / `mapState` / `mapMutations` / `mapWritableState`. */
export interface VueMappedMember {
  helper: string;
  /** The member's name in the store; null when the helper maps it to a function. */
  name: string | null;
  /** Where the member lives; null when the helper's first argument is not understood. */
  target: VueStoreTarget | null;
}

export type VuexKind = 'actions' | 'mutations' | 'getters' | 'state';

/** Edge contract rules 7 and 8: the store a Vuex or Pinia reference names. */
export type VueStoreTarget =
  /** A Vuex member by namespace path (null = the root namespace), or in the referring module itself. */
  | { store: 'vuex'; kind: VuexKind; namespace: string | null; local?: boolean }
  /** A member of the Pinia store `hook` (`useCartStore`), imported from `specifier` (null = this file). */
  | { store: 'pinia'; hook: string; specifier: string | null };

export type ReferenceType =
  | 'import'
  | 'require'
  | 'extends'
  | 'implements'
  | 'call'
  | 'instantiation'
  | 'return_type'
  | 'param_type'
  | 'relation'
  | 'route'
  | 'middleware'
  | 'binding'
  | 'dispatch'
  | 'notify'
  | 'hook'
  | 'graphql_resolver'
  | 'message_handler'
  | 'websocket_handler'
  | 'render'
  /** Frontend HTTP call → backend route handler (M2-06). */
  | 'http'
  /**
   * Client-side navigation (Vue Router `push` / `<router-link>`) → the component of the route record
   * it reaches (M3-06). Not `route`: that is a backend endpoint, rebuilt by the detect phase.
   */
  | 'navigate';

export interface ParseResult {
  symbols: ExtractedSymbol[];
  references: ExtractedReference[];
  errors: ParseError[];
  fileMetadata?: Record<string, any>;
}

export interface ParseError {
  message: string;
  line?: number;
}

export interface GraphEdge {
  id?: number;
  sourceFile: string;
  targetFile: string;
  sourceSymbol: string | null;
  targetSymbol: string | null;
  edgeType: ReferenceType;
  repo: string;
  weight: number;
  verifiability?: 'verified' | 'inferred';
  metadata?: Record<string, any>;
  targetRepo?: string | null;
}

export type ScanPhase = 'discover' | 'index' | 'parse' | 'resolve' | 'detect' | 'cluster';

export interface ScanProgress {
  phase: ScanPhase;
  current: number;
  total: number;
  file?: string;
}

export type ProgressCallback = (progress: ScanProgress) => void;

export interface ScanResult {
  filesScanned: number;
  symbolsFound: number;
  edgesFound: number;
  durationMs: number;
  languageBreakdown: Record<string, number>;
  interrupted?: boolean;
  totalFiles?: number;
}

export interface Snapshot {
  commitSha: string;
  parentSha: string | null;
  timestamp: string;
  filesAdded: string[];
  filesModified: string[];
  filesRemoved: string[];
  symbolsDelta: {
    added: number;
    removed: number;
    changed: number;
  };
}

export interface ExportOptions {
  format: 'llm' | 'json' | 'dot' | 'svg' | 'toon';
  tokenBudget: number;
  repo?: string;
  files?: string[];
  delimiter?: 'comma' | 'tab' | 'pipe';
  keyFolding?: boolean;
}

export interface RepoConfig {
  name: string;
  path: string;
  framework?: string;
  languages?: Record<string, UserLanguageDefinition>;
}

export interface UserLanguageDefinition {
  extensions: string[];
  grammarWasm: string;
  queries: {
    symbols?: string;
    references?: string;
  };
  nodeMappings: Partial<Record<SymbolKind, string>>;
}

export interface MapxConfig {
  version: string;
  repos: RepoConfig[];
  languages: Record<string, UserLanguageDefinition>;
  settings: {
    maxTokenBudget: number;
    excludePatterns: string[];
    includePatterns: string[];
    graphExcludePatterns?: string[];
    /**
     * Laravel's default excludes for `framework: laravel` repos (F10): true or absent applies them all,
     * false (declined at init) none, a list only the patterns it names (M0-02-R2).
     */
    laravelDefaultExcludes?: boolean | string[];
    php?: {
      facadeMap?: Record<string, string>;
    };
    /** Frontend HTTP clients MapX cannot recognise on its own (D008). */
    http?: {
      clients?: { receiver: string; baseURL?: string }[];
      /** Hosts of the workspace's own backends: absolute URLs on other hosts never pair (M2-06-R1). */
      hosts?: string[];
    };
    [key: string]: any;
  };
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string;
  isInitialized: boolean;
}

export interface MonorepoPackageInfo {
  /** Friendly name derived from the package manifest (e.g. package.json `name`). */
  name: string;
  /** Path relative to the workspace root (e.g. `apps/web`, `packages/shared`). */
  path: string;
  /** Package manager / build tool that declared this package (e.g. `npm`, `pnpm`, `cargo`). */
  packageManager: string;
}

// Universal roles — always active (7)
export type UniversalRole =
  | 'entry'          // Program entry points, CLI commands
  | 'config'         // Configuration files, env, manifests
  | 'types'          // Type definitions, interfaces, schemas, DTOs
  | 'shared'         // Utilities, helpers, common code
  | 'test'           // Tests, specs, fixtures
  | 'docs'           // Documentation
  | 'other';         // Uncategorised fallback

// Backend roles — activated when hasBackend (6)
export type BackendRole =
  | 'api'            // Routes, controllers, handlers, GraphQL resolvers
  | 'middleware'     // Request/response middleware, interceptors, guards
  | 'service'        // Business logic, domain services, use cases
  | 'data'           // Repositories, DAOs, models, migrations, seeds
  | 'integration'    // External API clients, SDK wrappers, message producers
  | 'auth';          // Authentication, authorization, identity

// Frontend roles — activated when hasFrontend (6)
export type FrontendRole =
  | 'pages'          // Page-level components, views, screens
  | 'components'     // Reusable UI components, widgets
  | 'state'          // State management, stores, reducers, atoms
  | 'hooks'          // Custom hooks, composables, mixins
  | 'styles'         // Stylesheets, themes, design tokens
  | 'assets';        // Static assets, images, fonts, icons

// Tool/Library roles — activated for cli-tool/library (4)
export type ToolRole =
  | 'cli'            // CLI interface, commands, argument parsing
  | 'core'           // Core library logic, main algorithms
  | 'parsers'        // Input parsing, deserialization
  | 'plugins';       // Plugin/extension system, adapters

// The effective taxonomy for a project is the union of universal + applicable domain roles
// (Also includes legacy layers for backward compatibility)
export type FileRole =
  | UniversalRole
  | BackendRole
  | FrontendRole
  | ToolRole
  | 'utils'
  | 'ui'
  | 'exporters'
  | 'agents'
  | 'frameworks'
  | 'scripts';

/**
 * Architectural layer a file belongs to, automatically inferred from its path,
 * name, and role in the system. Used to add vertical depth to cluster views.
 * Aliased to FileRole for backward compatibility.
 */
export type ArchLayer = FileRole;

export type CodebaseArchetype =
  | 'cli-tool' | 'web-api' | 'web-app' | 'full-stack'
  | 'library' | 'monorepo' | 'mobile-app' | 'mixed';

export type ArchPattern =
  | 'layered' | 'mvc' | 'mvvm' | 'hexagonal'
  | 'clean' | 'microkernel' | 'modular' | 'flat';

export interface CodebaseProfile {
  archetype: CodebaseArchetype;
  archetypeConfidence: number;       // 0.0–1.0
  detectedFrameworks: string[];      // ['express', 'react']
  detectedPatterns: ArchPattern[];   // ['mvc', 'layered']
  dominantLanguages: string[];       // ['typescript', 'javascript']
  hasBackend: boolean;
  hasFrontend: boolean;
  isMonorepo: boolean;
  componentBoundaries: string[];     // workspace package paths
}

export type SignalSource = 'path' | 'naming' | 'topology' | 'framework' | 'imports';

export interface ClassificationSignal {
  source: SignalSource;      // which signal produced this
  role: FileRole;            // suggested role
  confidence: number;        // 0.0–1.0
  reason: string;            // human-readable explanation
}

export interface ClassificationResult {
  filePath: string;
  role: FileRole;              // final classification
  confidence: number;          // overall confidence
  signals: ClassificationSignal[];  // all signals for explainability
  alternateRoles: FileRole[];  // runner-up roles
}

export interface WorkspaceInfo {
  path: string;
  repos: RepoConfig[];
}

export interface RepoSummary {
  name: string;
  path: string;
  type: 'primary' | 'submodule' | 'peer';
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  crossRepoEdgeCount: number;
  lastScanned: string | null;
  headSha: string | null;
}

export interface ScanContext {
  workspaceRoot: string;
  repoName: string;
  resolveSymbolToFile: (symbolName: string, sourcePath?: string) => string | null;
  /** The indexed file a JS/TS module specifier imported from `fromFile` resolves to (M3-06). */
  resolveImport?: (specifier: string, fromFile: string) => string | null;
}

export interface RouteBinding {
  framework: string;
  method: string;
  path: string;
  handlerFile: string;
  handlerSymbol?: string;
  middlewares?: string[];
  /** 1-based line of the declaration in its source file. */
  line?: number;
  metadata?: Record<string, any>;
}

export interface HookBinding {
  framework: string;
  hookName: string;
  hookType: string;
  handlerFile: string;
  handlerSymbol?: string;
  metadata?: Record<string, any>;
}

export interface FrameworkDetector {
  readonly name: string;
  readonly language: string;
  readonly filePattern: RegExp;
  detect(projectRoot: string, files: string[]): Promise<boolean>;
  /**
   * Manifest dependencies that activate this detector. `detect()` reads the repo root's manifest
   * and activates the detector for the whole repo; a manifest in a sub-folder (frontend/package.json)
   * activates it only for the files under that folder (M3-07).
   */
  readonly manifestDependencies?: { manifest: 'package.json' | 'composer.json'; names: string[] };
  extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]>;
  extractHooks?(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]>;
  /** Called once before a repo's files are extracted; drop any per-workspace cache here. */
  beginScan?(workspaceRoot: string): void;
  /** Called with every route this detector extracted in the repo, before edges are built. */
  finalizeRoutes?(routes: RouteBinding[]): void;
}

