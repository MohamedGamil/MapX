import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from '../wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS } from '../common-methods.js';

export class PhpParser implements LanguageParser {
  readonly languageName = 'php';
  readonly supportedExtensions = ['.php', '.phtml', '.php3', '.php4', '.php5', '.php7'];

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
    // F10: Noise Reduction / Exclusions
    if (filePath.includes('bootstrap/cache/') || filePath.endsWith('.blade.php')) {
      return { symbols: [], references: [], errors: [] };
    }

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

            if (kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum') {
              currentClass = name;
            }

            let signature = name;
            const parentNode = capture.node.parent;
            if (parentNode) {
              signature = this.extractSignature(source, parentNode, name, kind, startLine);
            }

            symbols.push({
              name,
              kind,
              scope: kind === 'method' || kind === 'property' || kind === 'constant'
                ? currentClass
                : null,
              signature,
              startLine,
              endLine,
              metadata: {},
            });
          }
        }
      }

      // F05: Build UseImportTable
      const useTable = new Map<string, string>();
      const useClauses = refCaptures.get('ref.target_use_clause') || [];
      for (const capture of useClauses) {
        const node = capture.node;
        const parent = node.parent;
        
        let prefix = '';
        if (parent && parent.type === 'namespace_use_group') {
          const grandParent = parent.parent;
          if (grandParent) {
            const prefixNode = grandParent.namedChildren.find((c: any) => c.type === 'namespace_name');
            if (prefixNode) {
              prefix = prefixNode.text;
            }
          }
        }

        const targetNode = (node.namedChildCount > 0 ? node.namedChild(0) : null) || node;
        const targetText = targetNode.text;
        const fullTarget = prefix ? `${prefix}\\${targetText}` : targetText;
        const startLine = node.startPosition.row + 1;

        // Populate useTable
        let aliasText = '';
        if (node.namedChildCount > 1) {
          const secondChild = node.namedChild(1);
          if (secondChild && secondChild.type === 'name') {
            aliasText = secondChild.text;
          }
        }

        const shortName = targetText.includes('\\')
          ? targetText.substring(targetText.lastIndexOf('\\') + 1)
          : targetText;

        const importName = aliasText || shortName;
        useTable.set(importName, fullTarget);

        // Emit import reference
        references.push({
          sourceSymbol: null,
          targetName: fullTarget,
          referenceType: 'import',
          startLine,
          verifiability: 'verified',
        });
      }

      const resolveToFqn = (name: string): string => {
        if (name.startsWith('\\')) {
          return name.substring(1);
        }
        if (name.includes('\\')) {
          return name;
        }
        return useTable.get(name) ?? name;
      };

      // Process standard captures (extends, implements, calls, instantiations)
      for (const [captureName, captures] of refCaptures) {
        if (captureName === 'ref.target_use_clause') continue;
        if (
          captureName === 'ref.target_param' ||
          captureName === 'ref.target_return_type' ||
          captureName === 'ref.target_property'
        ) {
          continue;
        }

        if (captureName.startsWith('ref.target_')) {
          const refType = captureName.replace('ref.target_', '');
          for (const capture of captures) {
            const targetName = capture.node.text;
            const startLine = capture.node.startPosition.row + 1;
            const cleaned = this.cleanTargetName(targetName, refType);
            const referenceType = this.mapRefType(refType);

            let verifiability: 'verified' | 'inferred' = 'verified';
            if (referenceType === 'call') {
              const parentType = capture.node.parent?.type;
              if (parentType === 'member_call_expression' || COMMON_FRAMEWORK_METHODS.has(cleaned)) {
                verifiability = 'inferred';
              }
            }

            // Resolve name to FQN if it is not a member call method name
            let resolvedTarget = cleaned;
            if (
              referenceType === 'extends' ||
              referenceType === 'implements' ||
              referenceType === 'instantiation' ||
              (referenceType === 'call' && capture.node.parent?.type === 'scoped_call_expression')
            ) {
              resolvedTarget = resolveToFqn(cleaned);
            }

            references.push({
              sourceSymbol: null,
              targetName: resolvedTarget,
              referenceType,
              startLine,
              verifiability,
            });
          }
        }
      }

      // F06: Helper function to find named type descendants
      const findNamedTypes = (node: any): any[] => {
        const results: any[] = [];
        if (node.type === 'named_type') {
          results.push(node);
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          results.push(...findNamedTypes(node.namedChild(i)));
        }
        return results;
      };

      // Helper function to find enclosing scope
      const getEnclosingScope = (node: any): { className: string | null; methodName: string | null } => {
        let className: string | null = null;
        let methodName: string | null = null;
        let curr = node.parent;
        while (curr) {
          if (curr.type === 'method_declaration' || curr.type === 'function_definition') {
            const nameNode = curr.namedChildren.find((c: any) => c.type === 'name');
            if (nameNode) methodName = nameNode.text;
          } else if (
            curr.type === 'class_declaration' ||
            curr.type === 'interface_declaration' ||
            curr.type === 'trait_declaration' ||
            curr.type === 'enum_declaration'
          ) {
            const nameNode = curr.namedChildren.find((c: any) => c.type === 'name');
            if (nameNode) className = nameNode.text;
            break;
          }
          curr = curr.parent;
        }
        return { className, methodName };
      };

      const SCALAR_TYPES = new Set([
        'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
        'array', 'object', 'callable', 'iterable', 'void', 'null', 'never',
        'mixed', 'self', 'static', 'parent',
        'Collection', 'Builder', 'Request', 'Response',
      ]);

      const processTypeHints = (capturesList: any[], edgeType: 'param_type' | 'return_type') => {
        for (const capture of capturesList) {
          const startLine = capture.node.startPosition.row + 1;
          const { className, methodName } = getEnclosingScope(capture.node);
          const sourceSymbol = methodName || className;

          const namedTypes = findNamedTypes(capture.node);
          for (const typeNode of namedTypes) {
            const typeText = typeNode.text;
            if (SCALAR_TYPES.has(typeText)) continue;
            if (typeText.startsWith('\\Illuminate\\') || typeText.startsWith('Illuminate\\')) continue;

            const resolved = resolveToFqn(typeText);
            references.push({
              sourceSymbol,
              targetName: resolved,
              referenceType: edgeType,
              startLine,
              verifiability: 'verified',
            });
          }
        }
      };

      processTypeHints(refCaptures.get('ref.target_param') || [], 'param_type');
      processTypeHints(refCaptures.get('ref.target_return_type') || [], 'return_type');
      processTypeHints(refCaptures.get('ref.target_property') || [], 'param_type');

      // F10: Classification of migration, seeder, and factory roles
      let isMigration = filePath.includes('/migrations/');
      let isSeeder = filePath.includes('/seeders/');
      let isFactory = filePath.includes('/factories/');

      const extendsCaptures = refCaptures.get('ref.target_extends') || [];
      for (const ext of extendsCaptures) {
        const extText = ext.node.text;
        if (extText === 'Migration' || extText === 'Illuminate\\Database\\Migrations\\Migration' || extText === '\\Illuminate\\Database\\Migrations\\Migration') {
          isMigration = true;
        }
        if (extText === 'Seeder' || extText === 'DatabaseSeeder') {
          isSeeder = true;
        }
        if (extText === 'Factory') {
          isFactory = true;
        }
      }

      let laravelRole: string | null = null;
      if (isMigration) laravelRole = 'migration';
      else if (isSeeder) laravelRole = 'seeder';
      else if (isFactory) laravelRole = 'factory';

      if (laravelRole) {
        for (const sym of symbols) {
          sym.metadata.laravelRole = laravelRole;
        }
        references.length = 0;
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
    const line = lines[lineIdx];
    const trimmed = line.trim();

    if (kind === 'method' || kind === 'function') {
      const match = trimmed.match(/function\s+\w+\s*\([^)]*\)/);
      if (match) {
        let sig = match[0];
        const colonIdx = trimmed.indexOf(':', trimmed.indexOf(')'));
        if (colonIdx !== -1) {
          const returnType = trimmed.substring(colonIdx, trimmed.indexOf('{') !== -1 ? trimmed.indexOf('{') : undefined).trim();
          if (returnType) sig += ' ' + returnType;
        }
        return sig;
      }
    }
    if (kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum') {
      const match = trimmed.match(/(class|interface|trait|enum)\s+\w+[^{]*/);
      if (match) return match[0].trim();
    }
    return name;
  }

  private cleanTargetName(name: string, refType: string): string {
    if (refType === 'require') {
      return name.replace(/^['"]|['"]$/g, '');
    }
    return name;
  }

  private mapRefType(refType: string): ExtractedReference['referenceType'] {
    const map: Record<string, ExtractedReference['referenceType']> = {
      import: 'import',
      require: 'require',
      extends: 'extends',
      implements: 'implements',
      call: 'call',
      instantiation: 'instantiation',
    };
    return map[refType] || 'call';
  }
}
