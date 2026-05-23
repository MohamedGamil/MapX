import type { SymbolKind } from '../types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LanguageDefinition {
  name: string;
  extensions: string[];
  grammarWasm: string;
  queries: {
    symbols: string;
    references: string;
  };
  nodeMappings: Partial<Record<SymbolKind, string>>;
  tier: 'built-in' | 'bundled' | 'installable' | 'user';
}

const BUILTIN_LANGUAGES: Record<string, LanguageDefinition> = {
  php: {
    name: 'php',
    extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php7'],
    grammarWasm: 'wasm/tree-sitter-php.wasm',
    queries: {
      symbols: 'queries/php/symbols.scm',
      references: 'queries/php/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      method: 'method_declaration',
      function: 'function_definition',
      interface: 'interface_declaration',
      trait: 'trait_declaration',
      constant: 'const_declaration',
      enum: 'enum_declaration',
      property: 'property_declaration',
      namespace: 'namespace_definition',
    },
    tier: 'built-in',
  },
  javascript: {
    name: 'javascript',
    extensions: ['.js', '.mjs', '.cjs'],
    grammarWasm: 'wasm/tree-sitter-javascript.wasm',
    queries: {
      symbols: 'queries/javascript/symbols.scm',
      references: 'queries/javascript/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      method: 'method_definition',
      function: 'function_declaration',
      interface: 'interface_declaration',
      constant: 'variable_declarator',
      enum: 'enum_declaration',
      property: 'property_identifier',
      namespace: 'internal_module',
      trait: '',
    },
    tier: 'built-in',
  },
  typescript: {
    name: 'typescript',
    extensions: ['.ts', '.cts', '.mts'],
    grammarWasm: 'wasm/tree-sitter-typescript.wasm',
    queries: {
      symbols: 'queries/typescript/symbols.scm',
      references: 'queries/typescript/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      method: 'method_definition',
      function: 'function_declaration',
      interface: 'interface_declaration',
      constant: 'variable_declarator',
      enum: 'enum_declaration',
      property: 'property_identifier',
      namespace: 'module',
      trait: '',
    },
    tier: 'built-in',
  },
  python: {
    name: 'python',
    extensions: ['.py'],
    grammarWasm: 'wasm/tree-sitter-python.wasm',
    queries: {
      symbols: 'queries/python/symbols.scm',
      references: 'queries/python/references.scm',
    },
    nodeMappings: {
      class: 'class_definition',
      function: 'function_definition',
      method: 'function_definition',
    },
    tier: 'built-in',
  },
  go: {
    name: 'go',
    extensions: ['.go'],
    grammarWasm: 'wasm/tree-sitter-go.wasm',
    queries: {
      symbols: 'queries/go/symbols.scm',
      references: 'queries/go/references.scm',
    },
    nodeMappings: {
      struct: 'type_spec',
      interface: 'type_spec',
      function: 'function_declaration',
      method: 'method_declaration',
    },
    tier: 'built-in',
  },
  rust: {
    name: 'rust',
    extensions: ['.rs'],
    grammarWasm: 'wasm/tree-sitter-rust.wasm',
    queries: {
      symbols: 'queries/rust/symbols.scm',
      references: 'queries/rust/references.scm',
    },
    nodeMappings: {
      struct: 'struct_item',
      interface: 'trait_item',
      enum: 'enum_item',
      function: 'function_item',
      method: 'function_item',
    },
    tier: 'built-in',
  },
  java: {
    name: 'java',
    extensions: ['.java'],
    grammarWasm: 'wasm/tree-sitter-java.wasm',
    queries: {
      symbols: 'queries/java/symbols.scm',
      references: 'queries/java/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      interface: 'interface_declaration',
      enum: 'enum_declaration',
      method: 'method_declaration',
    },
    tier: 'built-in',
  },
  'c-sharp': {
    name: 'c-sharp',
    extensions: ['.cs'],
    grammarWasm: 'wasm/tree-sitter-c_sharp.wasm',
    queries: {
      symbols: 'queries/c-sharp/symbols.scm',
      references: 'queries/c-sharp/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      interface: 'interface_declaration',
      enum: 'enum_declaration',
      struct: 'struct_declaration',
      method: 'method_declaration',
    },
    tier: 'built-in',
  },
  ruby: {
    name: 'ruby',
    extensions: ['.rb'],
    grammarWasm: 'wasm/tree-sitter-ruby.wasm',
    queries: {
      symbols: 'queries/ruby/symbols.scm',
      references: 'queries/ruby/references.scm',
    },
    nodeMappings: {
      class: 'class',
      method: 'method',
    },
    tier: 'bundled',
  },
  c: {
    name: 'c',
    extensions: ['.c', '.h'],
    grammarWasm: 'wasm/tree-sitter-c.wasm',
    queries: {
      symbols: 'queries/c/symbols.scm',
      references: 'queries/c/references.scm',
    },
    nodeMappings: {
      struct: 'struct_specifier',
      function: 'function_definition',
    },
    tier: 'bundled',
  },
  cpp: {
    name: 'cpp',
    extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.hh'],
    grammarWasm: 'wasm/tree-sitter-cpp.wasm',
    queries: {
      symbols: 'queries/cpp/symbols.scm',
      references: 'queries/cpp/references.scm',
    },
    nodeMappings: {
      class: 'class_specifier',
      struct: 'struct_specifier',
      function: 'function_definition',
    },
    tier: 'bundled',
  },
  swift: {
    name: 'swift',
    extensions: ['.swift'],
    grammarWasm: 'wasm/tree-sitter-swift.wasm',
    queries: {
      symbols: 'queries/swift/symbols.scm',
      references: 'queries/swift/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      struct: 'struct_declaration',
      method: 'function_declaration',
      function: 'function_declaration',
    },
    tier: 'bundled',
  },
  kotlin: {
    name: 'kotlin',
    extensions: ['.kt', '.kts'],
    grammarWasm: 'wasm/tree-sitter-kotlin.wasm',
    queries: {
      symbols: 'queries/kotlin/symbols.scm',
      references: 'queries/kotlin/references.scm',
    },
    nodeMappings: {
      class: 'class_declaration',
      method: 'function_declaration',
      function: 'function_declaration',
    },
    tier: 'bundled',
  },
  svelte: {
    name: 'svelte',
    extensions: ['.svelte'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-svelte.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'svelte', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'svelte', 'references.scm'),
    },
    nodeMappings: {
      function: 'function_declaration',
    },
    tier: 'installable',
  },
  vue: {
    name: 'vue',
    extensions: ['.vue'],
    grammarWasm: 'wasm/tree-sitter-vue.wasm',
    queries: {
      symbols: 'queries/vue/symbols.scm',
      references: 'queries/vue/references.scm',
    },
    nodeMappings: {
      function: 'function_declaration',
    },
    tier: 'bundled',
  },
  lua: {
    name: 'lua',
    extensions: ['.lua'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-lua.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'lua', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'lua', 'references.scm'),
    },
    nodeMappings: {
      function: 'function_definition',
    },
    tier: 'installable',
  },
  elixir: {
    name: 'elixir',
    extensions: ['.ex', '.exs'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-elixir.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'elixir', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'elixir', 'references.scm'),
    },
    nodeMappings: {
      module: 'call',
      function: 'call',
    },
    tier: 'installable',
  },
  zig: {
    name: 'zig',
    extensions: ['.zig'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-zig.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'zig', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'zig', 'references.scm'),
    },
    nodeMappings: {
      function: 'fn_proto',
    },
    tier: 'installable',
  },
  bash: {
    name: 'bash',
    extensions: ['.sh', '.bash'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-bash.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'bash', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'bash', 'references.scm'),
    },
    nodeMappings: {
      function: 'function_definition',
    },
    tier: 'installable',
  },
  pascal: {
    name: 'pascal',
    extensions: ['.pas', '.pp'],
    grammarWasm: join(homedir(), '.mapx', 'grammars', 'tree-sitter-pascal.wasm'),
    queries: {
      symbols: join(homedir(), '.mapx', 'grammars', 'queries', 'pascal', 'symbols.scm'),
      references: join(homedir(), '.mapx', 'grammars', 'queries', 'pascal', 'references.scm'),
    },
    nodeMappings: {
      function: 'function_declaration',
    },
    tier: 'installable',
  },
  dart: {
    name: 'dart',
    extensions: ['.dart'],
    grammarWasm: 'wasm/tree-sitter-dart.wasm',
    queries: {
      symbols: 'queries/dart/symbols.scm',
      references: 'queries/dart/references.scm',
    },
    nodeMappings: {
      class: 'class_definition',
      method: 'method_signature',
      function: 'function_signature',
    },
    tier: 'bundled',
  },
  scala: {
    name: 'scala',
    extensions: ['.scala', '.sc'],
    grammarWasm: 'wasm/tree-sitter-scala.wasm',
    queries: {
      symbols: 'queries/scala/symbols.scm',
      references: 'queries/scala/references.scm',
    },
    nodeMappings: {
      class: 'class_definition',
      function: 'function_definition',
    },
    tier: 'bundled',
  },
};

export function getBuiltinLanguages(): Record<string, LanguageDefinition> {
  return { ...BUILTIN_LANGUAGES };
}

export function getLanguageForFile(
  filePath: string,
  userLanguages: Record<string, LanguageDefinition> = {}
): LanguageDefinition | null {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  for (const lang of Object.values({ ...BUILTIN_LANGUAGES, ...userLanguages })) {
    if (lang.extensions.includes(ext)) {
      return lang;
    }
  }

  return null;
}

export function getLanguageNames(): string[] {
  return Object.keys(BUILTIN_LANGUAGES);
}

export function isBuiltInLanguage(name: string): boolean {
  return name in BUILTIN_LANGUAGES;
}
