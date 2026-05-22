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
  | 'namespace';

export interface ExtractedReference {
  sourceSymbol: string | null;
  targetName: string;
  referenceType: ReferenceType;
  startLine: number;
  verifiability?: 'verified' | 'inferred';
  metadata?: Record<string, any>;
}

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
  | 'notify';

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
  format: 'llm' | 'json' | 'dot' | 'svg';
  tokenBudget: number;
  repo?: string;
  files?: string[];
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
    php?: {
      facadeMap?: Record<string, string>;
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
