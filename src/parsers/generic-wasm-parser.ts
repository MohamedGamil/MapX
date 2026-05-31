import type { LanguageParser } from './parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from './wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS } from './common-methods.js';

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
            seenNodeIds.add(capture.node.id);

            let kind = baseKind;
            let name = nameByNodeId.get(capture.node.id);
            if (!name) {
              const isDefaultOrAnonymous =
                capture.node.type === 'arrow_function' ||
                capture.node.type === 'function_expression' ||
                (capture.node.type === 'function_declaration' && !capture.node.childForFieldName('name')) ||
                (capture.node.type === 'class_declaration' && !capture.node.childForFieldName('name')) ||
                (capture.node.type === 'class' && !capture.node.childForFieldName('name'));

              if (isDefaultOrAnonymous) {
                const baseName = filePath.split('/').pop() || '';
                name = baseName.replace(/\.[a-zA-Z0-9]+$/, '') || 'default';
              } else {
                name = capture.node.text;
              }
            }

            const startLine = capture.node.startPosition.row + 1;
            const endLine = capture.node.endPosition.row + 1;

            if (this.isContainerKind(kind)) {
               currentScope = name;
            }

            let extractedScope: string | null = null;

            // Auto-promote function to method if it is enclosed inside a container AST node
            if (kind === 'function') {
              let curr = capture.node.parent;
              while (curr) {
                if (
                  curr.type === 'class_definition' ||
                  curr.type === 'class_declaration' ||
                  curr.type === 'struct_specifier' ||
                  curr.type === 'impl_item' ||
                  curr.type === 'interface_declaration'
                ) {
                  kind = 'method';
                  if (curr.type === 'impl_item') {
                    const typeChild = curr.childForFieldName ? curr.childForFieldName('type') : null;
                    if (typeChild) {
                      extractedScope = typeChild.text;
                    }
                  }
                  break;
                }
                curr = curr.parent;
              }
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
            const targetText = capture.node.text;
            if (!targetText || typeof targetText !== 'string') continue;
            const targetName = this.cleanTarget(targetText, refType);
            if (!targetName || typeof targetName !== 'string') continue;

            if (refType === 'render') {
              const isReactComponent = /^[A-Z]/.test(targetName);
              if (!isReactComponent) continue;
            }

            const startLine = capture.node.startPosition.row + 1;
            const referenceType = this.mapRefType(refType);

            let verifiability: 'verified' | 'inferred' = 'verified';
            if (referenceType === 'call' && COMMON_FRAMEWORK_METHODS.has(targetName)) {
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
    if (refType === 'import' || refType === 'require') return name.replace(/^['"]|['"]$/g, '');
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
