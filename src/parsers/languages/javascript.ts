import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from '../wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS } from '../common-methods.js';

export class JavaScriptParser implements LanguageParser {
  readonly languageName = 'javascript';
  readonly supportedExtensions = ['.js', '.mjs', '.cjs'];

  private langDef: LanguageDefinition;
  private language: any = null;
  private symbolsQuery: string | null = null;
  private referencesQuery: string | null = null;
  private loadingPromise: Promise<void> | null = null;

  constructor(langDef: LanguageDefinition) {
    this.langDef = langDef;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        this.language = await loadLanguage(this.langDef);
        this.symbolsQuery = await loadQueryFile(this.langDef.queries.symbols);
        this.referencesQuery = await loadQueryFile(this.langDef.queries.references);
      })();
    }
    return this.loadingPromise;
  }

  async parse(filePath: string, source: string): Promise<ParseResult> {
    await this.ensureLoaded();
    const errors: ParseResult['errors'] = [];
    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];

    try {
      const { symbols: symCaptures, references: refCaptures, nameByNodeId } = await parseWithQueries(
        source, this.language, this.symbolsQuery!, this.referencesQuery!
      );

      let currentClass: string | null = null;

      for (const [captureName, captures] of symCaptures) {
        if (captureName.startsWith('symbol.kind_')) {
          const kind = captureName.replace('symbol.kind_', '') as SymbolKind;
          for (const capture of captures) {
            const name = nameByNodeId.get(capture.node.id) || capture.node.text;
            const startLine = capture.node.startPosition.row + 1;
            const endLine = capture.node.endPosition.row + 1;

            if (kind === 'class') currentClass = name;

            const signature = this.extractSignature(source, capture.node, name, kind, startLine);

            symbols.push({
              name,
              kind,
              scope: kind === 'method' ? currentClass : null,
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
            const targetName = this.cleanTarget(capture.node.text, refType);
            const startLine = capture.node.startPosition.row + 1;
            const referenceType = this.mapRefType(refType);

            let verifiability: 'verified' | 'inferred' = 'verified';
            if (referenceType === 'call' && COMMON_FRAMEWORK_METHODS.has(targetName)) {
              verifiability = 'inferred';
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

  private extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
    const lines = source.split('\n');
    const lineIdx = startLine - 1;
    if (lineIdx >= lines.length) return name;
    const line = lines[lineIdx].trim();

    if (kind === 'function') {
      const match = line.match(/(function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/);
      if (match) return match[0];
    }
    if (kind === 'method') {
      const match = line.match(/(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)/);
      if (match) return match[0];
    }
    if (kind === 'class') {
      const match = line.match(/class\s+\w+(\s+extends\s+\w+)?(\s+implements\s+\w+)?/);
      if (match) return match[0];
    }
    return name;
  }

  private cleanTarget(name: string, refType: string): string {
    if (refType === 'import') return name.replace(/^['"]|['"]$/g, '');
    return name;
  }

  private mapRefType(refType: string): ExtractedReference['referenceType'] {
    const map: Record<string, ExtractedReference['referenceType']> = {
      import: 'import', require: 'require', extends: 'extends',
      implements: 'implements', call: 'call', instantiation: 'instantiation',
    };
    return map[refType] || 'call';
  }
}
