import type { LanguageParser } from './parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from './wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS, JS_BUILTIN_METHODS, JS_BUILTIN_RECEIVERS } from './common-methods.js';

/** `import a.b.C` → [a.b.C]; `import a.b.{C, D => E}` → [a.b.C, a.b.D]; `import a.b._` → [a.b._]. */
function scalaImportTargets(node: any): string[] {
  const path = node.childrenForFieldName('path').filter((c: any) => c.type === 'identifier').map((c: any) => c.text).join('.');
  const selectors = node.namedChildren.find((c: any) => c.type === 'namespace_selectors');
  if (selectors) {
    return selectors.namedChildren
      .map((c: any) => (c.type === 'arrow_renamed_identifier' ? c.childForFieldName('name')?.text : c.type === 'identifier' ? c.text : null))
      .filter(Boolean)
      .map((name: string) => `${path}.${name}`);
  }
  if (node.namedChildren.some((c: any) => c.type === 'namespace_wildcard')) return [`${path}._`];
  return [path];
}

/**
 * C# `class A : Base, IRun`: the base list mixes one base class and interfaces. Only the first
 * entry of a class or record can be a class, and C# names interfaces `I<Upper>…`; structs only
 * implement; interfaces extend interfaces (M0-17-R1). `IOException`, `IPAddressAttribute` and
 * the like are classes: the .NET suffixes Exception, Attribute and EventArgs override the `I`
 * prefix (M0-17-R2). Null for anything that is not a base-list entry.
 */
function csharpBaseType(node: any): 'extends' | 'implements' | null {
  const list = node.parent;
  if (list?.type !== 'base_list') return null;
  const owner = list.parent?.type as string | undefined;
  if (owner === 'interface_declaration') return 'extends';
  if (owner === 'struct_declaration' || owner === 'record_struct_declaration') return 'implements';
  const first = list.namedChildren?.[0] ?? list.namedChild?.(0);
  if (first?.id !== node.id) return 'implements';
  const name = String(node.text).replace(/<[\s\S]*$/, '').split('.').pop() ?? '';
  return /^I[A-Z]/.test(name) && !/(Exception|Attribute|EventArgs)$/.test(name) ? 'implements' : 'extends';
}

/**
 * Import targets whose meaning the bare text loses (M0-12-R4): Ruby `require_relative 'x'` becomes
 * `./x`, relative to the file, unlike `require 'x'`. Other targets pass through.
 */
function markImportTarget(node: any, text: string): string {
  if (node.type === 'string_content') {
    const call = node.parent?.parent?.parent;
    if (call?.type === 'call' && call.childForFieldName('method')?.text === 'require_relative' && !text.startsWith('.')) return `./${text}`;
  }
  return text;
}

/** C# `namespace Outer { namespace Inner {} }` declares Outer.Inner (M0-12-R4). */
function csharpQualifiedNamespace(node: any, name: string): string {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'namespace_declaration') name = `${p.childForFieldName('name')?.text}.${name}`;
  }
  return name;
}

const JS_FUNCTION_NODES = new Set([
  'function_declaration', 'function_expression', 'function', 'arrow_function', 'method_definition',
  'generator_function_declaration', 'generator_function', 'class_static_block',
]);

/** True when a JS/TS node sits inside a function, arrow or method body. */
function insideFunctionBody(node: any): boolean {
  for (let curr = node.parent; curr; curr = curr.parent) {
    if (JS_FUNCTION_NODES.has(curr.type)) return true;
  }
  return false;
}

export class GenericWasmParser implements LanguageParser {
  readonly languageName: string;
  readonly supportedExtensions: string[];

  protected langDef: LanguageDefinition;
  protected language: any = null;
  protected symbolsQuery: string | null = null;
  protected referencesQuery: string | null = null;
  protected loadingPromise: Promise<void> | null = null;

  constructor(langDef: LanguageDefinition) {
    this.langDef = langDef;
    this.languageName = langDef.name;
    this.supportedExtensions = langDef.extensions;
  }

  protected ensureLoaded(): Promise<void> {
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        this.language = await loadLanguage(this.langDef);
        this.symbolsQuery = await loadQueryFile(this.langDef.queries.symbols);
        this.referencesQuery = await loadQueryFile(this.langDef.queries.references);
      })();
    }
    return this.loadingPromise;
  }

  async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    await this.ensureLoaded();
    const errors: ParseResult['errors'] = [];
    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];

    try {
      const { symbols: symCaptures, references: refCaptures, nameByNodeId, scopeByNodeId } = await parseWithQueries(
        source, this.language, this.symbolsQuery!, this.referencesQuery!
      );

      let currentScope: string | null = null;
      const seenNodeIds = new Set<number>();

      for (const [captureName, captures] of symCaptures) {
        if (captureName.startsWith('symbol.kind_')) {
          const baseKind = captureName.replace('symbol.kind_', '') as SymbolKind;
          for (const capture of captures) {
            if (seenNodeIds.has(capture.node.id)) continue;
            // A `const f = () => …` declarator is a function, claimed by the function pattern on
            // the same node: skip it here without marking it seen (M0-17-R1).
            if ((baseKind === 'constant' || baseKind === 'variable') && capture.node.type === 'variable_declarator') {
              const value = capture.node.childForFieldName('value')?.type;
              if (value === 'arrow_function' || value === 'function_expression' || value === 'function' || value === 'class' || value === 'generator_function') continue;
            }
            // A `const f = () => …` inside a function or method body is a local binding, like a
            // local constant, not a module function (M0-17-R3).
            if (baseKind === 'function' && capture.node.type === 'variable_declarator' && insideFunctionBody(capture.node)) continue;
            seenNodeIds.add(capture.node.id);

            let kind = baseKind;
            let name = nameByNodeId.get(capture.node.id);
            if (!name) {
              const isDefaultOrAnonymous =
                capture.node.type === 'arrow_function' ||
                capture.node.type === 'function_expression' ||
                (capture.node.type === 'function_declaration' && !capture.node.childForFieldName('name')) ||
                (capture.node.type === 'class_declaration' && !capture.node.childForFieldName('name')) ||
                (capture.node.type === 'class' && !capture.node.childForFieldName('name')) ||
                capture.node.type === 'script_element';

              if (isDefaultOrAnonymous) {
                const baseName = filePath.split('/').pop() || '';
                name = baseName.replace(/\.[a-zA-Z0-9]+$/, '') || 'default';
                // Members of `export default class { … }` take this derived name as their scope.
                nameByNodeId.set(capture.node.id, name);
              } else {
                name = capture.node.text;
              }
            }

            if (kind === 'namespace' && capture.node.type === 'namespace_declaration') name = csharpQualifiedNamespace(capture.node, name);

            const startLine = capture.node.startPosition.row + 1;
            const endLine = capture.node.endPosition.row + 1;

            if (this.isContainerKind(kind)) {
               currentScope = name;
            }

            let extractedScope: string | null = null;

            // Kotlin declares interfaces and enums with class_declaration too: `interface Shape`,
            // `enum class Color` (M0-17-R1).
            if (kind === 'class' && capture.node.type === 'class_declaration') {
              const tokens = capture.node.children.flatMap((c: any) => (c.type === 'modifiers' ? c.text.split(/\s+/) : [c.type]));
              if (tokens.includes('interface')) kind = 'interface';
              else if (tokens.includes('enum')) kind = 'enum';
            }

            // C++ out-of-line definition `void Foo::run() {}`: a method of Foo (M0-17-R1). The
            // owner is the innermost qualifier (`ns::K::a` → K), without template arguments
            // (`Box<T>::f` → Box) (M0-17-R2).
            if (kind === 'function' && capture.node.type === 'function_definition') {
              let qualified = capture.node.childForFieldName('declarator')?.childForFieldName('declarator');
              while (qualified?.type === 'qualified_identifier' && qualified.childForFieldName('name')?.type === 'qualified_identifier') {
                qualified = qualified.childForFieldName('name');
              }
              let owner = qualified?.type === 'qualified_identifier' ? qualified.childForFieldName('scope') : null;
              if (owner?.type === 'template_type') owner = owner.childForFieldName('name');
              if (owner) {
                kind = 'method';
                extractedScope = owner.text;
              }
            }

            // Auto-promote function to method if it is enclosed inside a container AST node
            if (kind === 'function') {
              let curr = capture.node.parent;
              while (curr) {
                if (
                  curr.type === 'class_definition' ||
                  curr.type === 'class_declaration' ||
                  curr.type === 'class_specifier' ||
                  curr.type === 'struct_specifier' ||
                  curr.type === 'impl_item' ||
                  curr.type === 'interface_declaration'
                ) {
                  kind = 'method';
                  if (curr.type === 'impl_item') {
                    const typeChild = curr.childForFieldName ? curr.childForFieldName('type') : null;
                    if (typeChild) {
                      extractedScope = typeChild.text.replace(/<[\s\S]*$/, '');
                    }
                  }
                  break;
                }
                curr = curr.parent;
              }
            }

            // Python `@property` / `@cached_property` methods are properties (M0-17-R1).
            if (kind === 'method' && capture.node.parent?.type === 'decorated_definition') {
              const decorators = capture.node.parent.namedChildren.filter((c: any) => c.type === 'decorator').map((c: any) => c.text as string);
              if (decorators.some((d: string) => /^@(\w+\.)?(property|cached_property)$/.test(d.trim()))) kind = 'property';
            }

            const signature = this.extractSignature(source, capture.node, name, kind, startLine);

            const explicitScope = scopeByNodeId.get(capture.node.id) || extractedScope;
            let resolvedScope = explicitScope;
            if (!resolvedScope && this.isMemberKind(kind)) {
              let curr = capture.node.parent;
              while (curr) {
                const parentName = nameByNodeId.get(curr.id);
                if (parentName) {
                  resolvedScope = parentName;
                  break;
                }
                curr = curr.parent;
              }
            }

            if (options?.ignoredSymbols?.has(name)) {
              continue;
            }

            symbols.push({
              name,
              kind,
              scope: resolvedScope,
              signature,
              startLine,
              endLine,
              metadata: {},
            });
          }
        }
      }

      for (const [captureName, captures] of refCaptures) {
        if (captureName.startsWith('ref.target_')) {
          const refType = captureName.replace('ref.target_', '');
          for (const capture of captures) {
            // Scala `import a.b.{C, D => E}` is one node naming several targets (M0-17-R1).
            const targetTexts = capture.node.type === 'import_declaration' && refType === 'import'
              ? scalaImportTargets(capture.node)
              : [refType === 'import' || refType === 'require' ? markImportTarget(capture.node, capture.node.text) : capture.node.text];
            for (const targetText of targetTexts) {
            if (!targetText || typeof targetText !== 'string') continue;
            const csharpBase = csharpBaseType(capture.node);
            // A C# generic base `List<int>` names the type List (M0-17-R2).
            const targetName = csharpBase ? targetText.replace(/<[\s\S]*$/, '').trim() : this.cleanTarget(targetText, refType);
            if (!targetName || typeof targetName !== 'string') continue;

            if (refType === 'render') {
              const isReactComponent = /^[A-Z]/.test(targetName);
              if (!isReactComponent) continue;
            }

            const startLine = capture.node.startPosition.row + 1;
            const referenceType = csharpBase ?? this.mapRefType(refType);

            let verifiability: 'verified' | 'inferred' = 'verified';
            if (referenceType === 'call' && COMMON_FRAMEWORK_METHODS.has(targetName)) {
              verifiability = 'inferred';
            }
            // obj.method() on an untyped receiver (not `this`): name-only, so inferred (F01).
            const member = capture.node.parent;
            const receiver = member?.type === 'member_expression' ? member.childForFieldName?.('object') : null;
            if (referenceType === 'call' && receiver?.type === 'identifier') {
              // `Math.max()`, `process.exit()`: a built-in object's method, not user code (M0-17-R2).
              if (JS_BUILTIN_METHODS.has(targetName) || JS_BUILTIN_RECEIVERS.has(receiver.text)) continue;
              verifiability = 'inferred';
            }

            if (options?.ignoredSymbols?.has(targetName)) {
              continue;
            }

            references.push({
              sourceSymbol: null,
              targetName,
              referenceType,
              startLine,
              verifiability,
            });
            }
          }
        }
      }
    } catch (e: any) {
      errors.push({ message: e.message, line: 0 });
    }

    return { symbols, references, errors };
  }

  protected isContainerKind(kind: SymbolKind): boolean {
    return kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum' || kind === 'struct' || kind === 'module';
  }

  protected isMemberKind(kind: SymbolKind): boolean {
    return kind === 'method' || kind === 'property' || kind === 'constant' || kind === 'field';
  }



  protected extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
    const lines = source.split('\n');
    const lineIdx = startLine - 1;
    if (lineIdx >= lines.length) return name;
    const line = lines[lineIdx].trim();

    if (kind === 'function') {
      const match = line.match(/(?:export\s+)?(?:async\s+)?function\s+\w+[^{]*/);
      if (match) return match[0].trim();
    }
    if (kind === 'method') {
      const match = line.match(/(?:abstract\s+)?(?:private|protected|public)?\s*(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)(\s*:\s*[^{;]+)?/);
      if (match) return match[0].trim();
    }
    if (kind === 'class') {
      const match = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+\w+[^{]*/);
      if (match) return match[0].trim();
    }
    if (kind === 'interface') {
      const match = line.match(/(?:export\s+)?interface\s+\w+[^{]*/);
      if (match) return match[0].trim();
    }
    if (kind === 'enum') {
      const match = line.match(/(?:export\s+)?enum\s+\w+/);
      if (match) return match[0].trim();
    }
    return name;
  }

  protected cleanTarget(name: string, refType: string): string {
    if (refType === 'import' || refType === 'require') {
      let cleaned = name.trim();
      if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      return cleaned.replace(/^['"]|['"]$/g, '');
    }
    return name;
  }

  protected mapRefType(refType: string): ExtractedReference['referenceType'] {
    const map: Record<string, ExtractedReference['referenceType']> = {
      import: 'import',
      import_name: 'import',
      require: 'require',
      part: 'import',
      part_of: 'import',
      extends: 'extends',
      implements: 'implements',
      call: 'call',
      instantiation: 'instantiation',
      render: 'render',
      param_type: 'param_type',
      return_type: 'return_type',
    };
    return map[refType] || 'call';
  }
}
