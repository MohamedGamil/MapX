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
  tier: 'built-in' | 'bundled' | 'installable' | 'user' | 'static';
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
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
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
  tsx: {
    name: 'tsx',
    extensions: ['.tsx'],
    grammarWasm: 'wasm/tree-sitter-tsx.wasm',
    queries: {
      symbols: 'queries/typescript/symbols.scm',
      references: 'queries/typescript/references-tsx.scm',
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
      constant: 'expression_statement',
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
      constant: 'const_spec',
      namespace: 'package_clause',
      property: 'var_spec',
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
      class: 'impl_item',
      constant: 'const_item',
      module: 'mod_item',
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
      property: 'field_declaration',
      constant: 'enum_constant',
      namespace: 'package_declaration',
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
      property: 'property_declaration',
      constant: 'enum_member_declaration',
      namespace: 'namespace_declaration',
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
      module: 'module',
      constant: 'assignment',
      property: 'call',
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
      enum: 'enum_specifier',
      constant: 'preproc_def',
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
      namespace: 'namespace_definition',
      enum: 'enum_specifier',
      constant: 'alias_declaration',
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
      interface: 'protocol_declaration',
      enum: 'enum_declaration',
      method: 'function_declaration',
      function: 'function_declaration',
      property: 'property_declaration',
      constant: 'typealias_declaration',
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
      interface: 'class_declaration',
      property: 'property_declaration',
      constant: 'enum_entry',
    },
    tier: 'bundled',
  },
  svelte: {
    name: 'svelte',
    extensions: ['.svelte'],
    grammarWasm: 'wasm/tree-sitter-svelte.wasm',
    queries: {
      symbols: 'queries/svelte/symbols.scm',
      references: 'queries/svelte/references.scm',
    },
    nodeMappings: {
      function: 'function_declaration',
      class: 'class_declaration',
      method: 'method_definition',
      property: 'export_statement',
      constant: 'lexical_declaration',
    },
    tier: 'bundled',
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
      class: 'class_declaration',
      method: 'method_definition',
      property: 'pair',
    },
    tier: 'bundled',
  },
  lua: {
    name: 'lua',
    extensions: ['.lua'],
    grammarWasm: 'wasm/tree-sitter-lua.wasm',
    queries: {
      symbols: 'queries/lua/symbols.scm',
      references: 'queries/lua/references.scm',
    },
    nodeMappings: {
      function: 'function_definition',
      method: 'function_definition',
      constant: 'variable_assignment',
    },
    tier: 'bundled',
  },
  elixir: {
    name: 'elixir',
    extensions: ['.ex', '.exs'],
    grammarWasm: 'wasm/tree-sitter-elixir.wasm',
    queries: {
      symbols: 'queries/elixir/symbols.scm',
      references: 'queries/elixir/references.scm',
    },
    nodeMappings: {
      module: 'call',
      function: 'call',
      struct: 'call',
      interface: 'call',
      constant: 'unary_operator',
    },
    tier: 'bundled',
  },
  zig: {
    name: 'zig',
    extensions: ['.zig'],
    grammarWasm: 'wasm/tree-sitter-zig.wasm',
    queries: {
      symbols: 'queries/zig/symbols.scm',
      references: 'queries/zig/references.scm',
    },
    nodeMappings: {
      function: 'fn_proto',
      struct: 'variable_declaration',
      constant: 'variable_declaration',
      enum: 'error_set_declaration',
    },
    tier: 'bundled',
  },
  bash: {
    name: 'bash',
    extensions: ['.sh', '.bash'],
    grammarWasm: 'wasm/tree-sitter-bash.wasm',
    queries: {
      symbols: 'queries/bash/symbols.scm',
      references: 'queries/bash/references.scm',
    },
    nodeMappings: {
      function: 'function_definition',
      constant: 'variable_assignment',
    },
    tier: 'bundled',
  },
  pascal: {
    name: 'pascal',
    extensions: ['.pas', '.pp'],
    grammarWasm: 'wasm/tree-sitter-pascal.wasm',
    queries: {
      symbols: 'queries/pascal/symbols.scm',
      references: 'queries/pascal/references.scm',
    },
    nodeMappings: {
      function: 'function_declaration',
      class: 'class_declaration',
      struct: 'record_declaration',
      interface: 'interface_declaration',
      method: 'method_declaration',
      constant: 'constant_declaration',
      module: 'unit_declaration',
      property: 'variable_declaration',
      enum: 'enum_type',
    },
    tier: 'bundled',
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
      enum: 'enum_declaration',
      trait: 'mixin_declaration',
      constant: 'top_level_definition',
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
      interface: 'trait_definition',
      constant: 'val_definition',
      property: 'var_definition',
      namespace: 'package_clause',
    },
    tier: 'bundled',
  },
  // Static file types: indexed for dependency tracking only, no symbol extraction
  markdown: {
    name: 'markdown',
    extensions: ['.md', '.mdx', '.markdown'],
    grammarWasm: '',
    queries: { symbols: '', references: '' },
    nodeMappings: {},
    tier: 'static',
  },
  html: {
    name: 'html',
    extensions: ['.html', '.htm', '.xhtml'],
    grammarWasm: '',
    queries: { symbols: '', references: '' },
    nodeMappings: {},
    tier: 'static',
  },
  css: {
    name: 'css',
    extensions: ['.css', '.scss', '.sass', '.less'],
    grammarWasm: '',
    queries: { symbols: '', references: '' },
    nodeMappings: {},
    tier: 'static',
  },
  json: {
    name: 'json',
    extensions: ['.json', '.jsonc', '.json5'],
    grammarWasm: '',
    queries: { symbols: '', references: '' },
    nodeMappings: {},
    tier: 'static',
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

export function areLanguagesCompatible(lang1: string, lang2: string): boolean {
  const l1 = lang1.toLowerCase();
  const l2 = lang2.toLowerCase();
  if (l1 === l2) return true;

  const jsTsGroup = new Set(['javascript', 'typescript', 'tsx', 'vue', 'svelte', 'astro']);
  if (jsTsGroup.has(l1) && jsTsGroup.has(l2)) return true;

  const cppGroup = new Set(['c', 'cpp', 'c++', 'objective-c', 'objective-cpp']);
  if (cppGroup.has(l1) && cppGroup.has(l2)) return true;

  const jvmGroup = new Set(['java', 'kotlin', 'scala', 'groovy']);
  if (jvmGroup.has(l1) && jvmGroup.has(l2)) return true;

  return false;
}
