import type { SymbolKind } from '../types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LanguageDefinition {
  name: string;
  extensions: string[];
  /** Exact file names (no extension) that belong to the language, e.g. `Rakefile`. */
  filenames?: string[];
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
    extensions: ['.py', '.pyw'],
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
    extensions: ['.rb', '.rake', '.gemspec'],
    filenames: ['Rakefile', 'Gemfile'],
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
    extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.hh', '.h++', '.c++'],
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
    extensions: ['.lua', '.luau'],
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
    extensions: ['.sh', '.bash', '.zsh'],
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
    extensions: ['.pas', '.pp', '.dpr', '.lpr'],
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
      // method_declaration = concrete method; method_signature = abstract method
      method: 'method_declaration',
      // function_declaration = concrete top-level function
      function: 'function_declaration',
      interface: 'abstract_class_declaration',
      enum: 'enum_declaration',
      trait: 'mixin_declaration',
      // type_alias covers Dart 2.13+ typedef; function_type_alias covers legacy
      constant: 'type_alias',
      property: 'getter_declaration',
      namespace: 'library_declaration',
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
  yaml: {
    name: 'yaml',
    extensions: ['.yaml', '.yml'],
    grammarWasm: '',
    queries: { symbols: '', references: '' },
    nodeMappings: {},
    tier: 'static',
  },
  // F20 lists `.fish` under Bash, but fish syntax is not bash (the bash grammar mis-parses it), so
  // fish has its own grammar: ram02z/tree-sitter-fish 3.7.0, Unlicense (D014, M0-12-R5).
  fish: {
    name: 'fish',
    extensions: ['.fish'],
    grammarWasm: 'wasm/tree-sitter-fish.wasm',
    queries: {
      symbols: 'queries/fish/symbols.scm',
      references: 'queries/fish/references.scm',
    },
    nodeMappings: {
      function: 'function_definition',
    },
    tier: 'bundled',
  },
};

export function getBuiltinLanguages(): Record<string, LanguageDefinition> {
  return { ...BUILTIN_LANGUAGES };
}

/**
 * The language count docs and agent templates state: every language with a grammar, TSX counted
 * as TypeScript; static file types (Markdown, HTML, …) are not languages (M0-12-R6).
 */
export function supportedLanguageCount(): number {
  return Object.values(BUILTIN_LANGUAGES).filter((l) => l.tier !== 'static' && l.name !== 'tsx').length;
}

/** Interpreter named by a `#!` line → language, for extensionless scripts. */
const SHEBANG_LANGUAGES: [RegExp, string][] = [
  [/\b(?:ba|z|k|da)?sh\b/, 'bash'],
  [/\bpython[\d.]*\b/, 'python'],
  [/^(?:ts-node|tsx)$/, 'typescript'],
  [/^fish$/, 'fish'],
  [/\b(?:node|nodejs|deno|bun)\b/, 'javascript'],
  [/\bruby\b/, 'ruby'],
  [/\bphp\b/, 'php'],
  [/\blua(?:jit)?\b/, 'lua'],
  [/\belixir\b/, 'elixir'],
];

export function languageFromShebang(firstLine: string): LanguageDefinition | null {
  if (!firstLine.startsWith('#!')) return null;
  // `#!/usr/bin/env -S node --flag` → node; `#!/bin/bash -e` → bash
  const words = firstLine.slice(2).trim().split(/\s+/);
  const interpreter = (words[0]?.endsWith('/env') ? words.find((w, i) => i > 0 && !w.startsWith('-')) : words[0]) ?? '';
  const base = interpreter.split('/').pop() ?? '';
  for (const [re, name] of SHEBANG_LANGUAGES) if (re.test(base)) return BUILTIN_LANGUAGES[name] ?? null;
  return null;
}

/**
 * The logical lines of a C or C++ header (M5-03-R2): `\`-continued lines joined, comments and
 * string and character literals dropped (`"C++"` kept for `extern "C++"`), each line trimmed, blank
 * lines left out. One pass, linear in the text.
 */
function headerLines(text: string): string[] {
  let code = '';
  let from = 0;
  let i = 0;
  const n = text.length;
  const cut = (to: number, insert: string, next: number) => { code += text.slice(from, to) + insert; from = i = next; };
  while (i < n) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') cut(i, '', i + 2);
    else if (c === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') cut(i, '', i + 3);
    else if (c === '/' && text[i + 1] === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j += text[j] === '\\' && text[j + 1] === '\n' ? 2 : 1;
      cut(i, '', j);
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      cut(i, ' ', end < 0 ? n : end + 2);
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      // An unterminated literal ends at its line (`it's` in a stray text line).
      cut(i, c === '"' && text.slice(i + 1, j) === 'C++' ? '"C++"' : c + c, text[j] === c ? j + 1 : j);
    } else i++;
  }
  code += text.slice(from);
  const lines: string[] = [];
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (t) lines.push(t);
  }
  return lines;
}

/** `template <`, an access label, `using namespace`, `extern "C++"`, on a trimmed line. */
const CPP_LINE = /^(?:template\s*<|(?:public|protected|private)\s*:(?!:)|using\s+namespace\b|extern\s*"C\+\+")/;
const NAMESPACE_DECL = /^namespace(?:\s+[A-Za-z_][\w:]*)?\s*([\s\S]*)$/;
const CLASS_DECL = /^class\s+[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*\s*([\s\S]*)$/;

/** C++-only syntax on a trimmed logical line; `next` is the line after it, for a body opened there. */
function cppLine(line: string, next: string | undefined): boolean {
  if (CPP_LINE.test(line)) return true;
  // `namespace acme {`, `class API Order : public Base {`: a declaration with a body. Not `class A;`,
  // nor a C variable named `namespace` or `class`.
  const decl = line.startsWith('namespace') ? NAMESPACE_DECL.exec(line) : line.startsWith('class') ? CLASS_DECL.exec(line) : null;
  if (!decl) return false;
  const rest = decl[1]!;
  if (rest.startsWith('{') || (!rest && next?.startsWith('{'))) return true;
  return line.startsWith('class') && rest.startsWith(':') && !rest.startsWith('::');
}

/** The preprocessor directive of a logical line (`if`, `ifdef`, `endif`, …), or null. */
const directiveOf = (line: string) => (line.startsWith('#') ? /^#\s*(\w*)/.exec(line)![1]! : null);

/**
 * Whether a `.h` header is C++ (M5-03-R2). Conservative, so a C header never turns into C++: the
 * header must use C++-only syntax outside every preprocessor conditional. That syntax is
 * `namespace X {`, a `class X {` or `class X :` declaration, `template <`, an access label,
 * `using namespace` or `extern "C++"`. Comments and literals do not count. An include guard that
 * wraps the whole file is not a conditional. Anything inside `#if`, `#ifdef`, `#ifndef`, `#elif`
 * or `#else` never counts, whatever it tests (`__cplusplus`, `0`, a feature macro). The rule reads
 * only the file's own text, so a header's language does not depend on its neighbours.
 */
export function isCppHeader(text: string): boolean {
  const lines = headerLines(text);
  // An include guard: `#ifndef G` / `#if !defined(G)`, then `#define G`, closed by the last line.
  let first = 0;
  while (directiveOf(lines[first] ?? '') === 'pragma') first++;
  const guard = /^#\s*(?:ifndef\s+(\w+)$|if\s+!\s*defined\s*\(?\s*(\w+)\s*\)?$)/.exec(lines[first] ?? '');
  let base = 0;
  if (guard && new RegExp(`^#\\s*define\\s+${guard[1] ?? guard[2]}(?:\\s|$)`).test(lines[first + 1] ?? '')) {
    let depth = 0;
    for (let k = first; k < lines.length; k++) {
      const d = directiveOf(lines[k]!);
      if (d === 'if' || d === 'ifdef' || d === 'ifndef') depth++;
      else if (depth === 1 && (d === 'else' || d === 'elif')) break;
      else if (d === 'endif' && --depth === 0) {
        if (k === lines.length - 1) base = 1;
        break;
      }
    }
  }
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    const d = directiveOf(line);
    if (d === 'if' || d === 'ifdef' || d === 'ifndef') depth++;
    else if (d === 'endif') depth--;
    else if (d === null && depth <= base && cppLine(line, lines[k + 1])) return true;
  }
  return false;
}

export function getLanguageByName(name: string, userLanguages: Record<string, LanguageDefinition> = {}): LanguageDefinition | null {
  return ({ ...BUILTIN_LANGUAGES, ...userLanguages } as Record<string, LanguageDefinition>)[name] ?? null;
}

export function getLanguageForFile(
  filePath: string,
  userLanguages: Record<string, LanguageDefinition> = {}
): LanguageDefinition | null {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);

  for (const lang of Object.values({ ...BUILTIN_LANGUAGES, ...userLanguages })) {
    if (lang.extensions.includes(ext) || lang.filenames?.includes(base)) {
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
