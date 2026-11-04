import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from '../wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS } from '../common-methods.js';
import { GenericWasmParser } from '../generic-wasm-parser.js';
import { symbolAnnotations } from '../annotations.js';
import { ambientAccesses } from '../ambient.js';

export const LARAVEL_FACADE_MAP: Record<string, string> = {
  App:           'Illuminate\\Foundation\\Application',
  Auth:          'Illuminate\\Auth\\AuthManager',
  Bus:           'Illuminate\\Contracts\\Bus\\Dispatcher',
  Cache:         'Illuminate\\Cache\\CacheManager',
  Config:        'Illuminate\\Config\\Repository',
  Cookie:        'Illuminate\\Cookie\\CookieJar',
  Crypt:         'Illuminate\\Encryption\\Encrypter',
  DB:            'Illuminate\\Database\\DatabaseManager',
  Event:         'Illuminate\\Events\\Dispatcher',
  File:          'Illuminate\\Filesystem\\Filesystem',
  Gate:          'Illuminate\\Auth\\Access\\Gate',
  Hash:          'Illuminate\\Hashing\\HashManager',
  Http:          'Illuminate\\Http\\Client\\Factory',
  Lang:          'Illuminate\\Translation\\Translator',
  Log:           'Illuminate\\Log\\LogManager',
  Mail:          'Illuminate\\Mail\\Mailer',
  Notification:  'Illuminate\\Notifications\\ChannelManager',
  Password:      'Illuminate\\Auth\\Passwords\\PasswordBrokerManager',
  Queue:         'Illuminate\\Queue\\QueueManager',
  RateLimiter:   'Illuminate\\Cache\\RateLimiter',
  Redirect:      'Illuminate\\Routing\\Redirector',
  Request:       'Illuminate\\Http\\Request',
  Response:      'Illuminate\\Routing\\ResponseFactory',
  Route:         'Illuminate\\Routing\\Router',
  Schema:        'Illuminate\\Database\\Schema\\Builder',
  Session:       'Illuminate\\Session\\SessionManager',
  Storage:       'Illuminate\\Filesystem\\FilesystemManager',
  URL:           'Illuminate\\Routing\\UrlGenerator',
  Validator:     'Illuminate\\Validation\\Factory',
  View:          'Illuminate\\View\\Factory',
};

const PHP_NAMESPACED_KINDS = new Set(['class', 'interface', 'trait', 'enum', 'function']);
const PHP_TYPE_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);

/** The class, interface, trait or enum declaration a node sits in, or null. */
function phpEnclosingType(node: any): any {
  for (let p = node.parent; p; p = p.parent) if (PHP_TYPE_DECLARATIONS.has(p.type)) return p;
  return null;
}

/**
 * The adaptation rules of a `use A, B { … }` block: `B::x insteadof A, C` (`insteadof`: the method,
 * and its winning trait) and `A::x as [visibility] ax` / `x as ax`
 * (`aliases`: the new name, the trait method it names, the trait when written). A rule that only
 * changes visibility (`x as protected`) is dropped; null when there are none.
 */
function phpTraitRules(useLists: any[], qualify: (name: string) => string): { insteadof?: Array<{ method: string; winner: string }>; aliases?: Array<{ alias: string; method: string; trait?: string }> } | null {
  const insteadof: Array<{ method: string; winner: string }> = [];
  const aliases: Array<{ alias: string; method: string; trait?: string }> = [];
  for (const list of useLists) {
    for (const clause of list.namedChildren) {
      const [first, ...rest] = clause.namedChildren.filter((c: any) => c.type !== 'comment');
      if (!first) continue;
      // `Trait::method` or a bare `method`.
      const qualified = first.type === 'class_constant_access_expression';
      const method = qualified ? first.namedChildren.at(-1)?.text : first.text;
      const trait = qualified ? first.namedChildren[0]?.text : undefined;
      if (!method) continue;
      if (clause.type === 'use_instead_of_clause' && trait) {
        insteadof.push({ method, winner: qualify(trait) });
      } else if (clause.type === 'use_as_clause') {
        const alias = rest.filter((c: any) => c.type === 'name').at(-1)?.text;
        if (alias) aliases.push({ alias, method, ...(trait ? { trait: qualify(trait) } : {}) });
      }
    }
  }
  return insteadof.length || aliases.length ? { ...(insteadof.length ? { insteadof } : {}), ...(aliases.length ? { aliases } : {}) } : null;
}

export class PhpParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }

  async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    // F10: Noise Reduction / Exclusions
    if (filePath.includes('bootstrap/cache/') || filePath.endsWith('.blade.php')) {
      return { symbols: [], references: [], errors: [] };
    }

    await this.ensureLoaded();
    const errors: ParseResult['errors'] = [];

    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];
    let fileMetadata: Record<string, any> | undefined = undefined;
    let ambient: ParseResult['ambient'];

    let parsed: Awaited<ReturnType<typeof parseWithQueries>> | undefined;
    try {
      parsed = await parseWithQueries(
        source, this.language, this.symbolsQuery!, this.referencesQuery!,
        // Superglobals and getenv() (M5-24-R1).
        (root) => { ambient = ambientAccesses('php', root, source); },
      );
      const { symbols: symCaptures, references: refCaptures, nameByNodeId } = parsed;

      // Each symbol's declaration node, for its attributes and PHPDoc tags once `use` is read (M5-10).
      const declarations: Array<[ExtractedSymbol, any]> = [];

      for (const [captureName, captures] of symCaptures) {
        if (captureName.startsWith('symbol.kind_')) {
          const kind = captureName.replace('symbol.kind_', '') as SymbolKind;
          for (const capture of captures) {
            const name = nameByNodeId.get(capture.node.id) || capture.node.text;
            const startLine = capture.node.startPosition.row + 1;
            const endLine = capture.node.endPosition.row + 1;

            if (kind === 'namespace') {
              if (!fileMetadata) fileMetadata = {};
              fileMetadata.namespace = name;
              continue;
            }

            let signature = name;
            const parentNode = capture.node.parent;
            if (parentNode) {
              signature = this.extractSignature(source, parentNode, name, kind, startLine);
            }

            const symbol: ExtractedSymbol = {
              name,
              kind,
              // The type the member is declared in, from the syntax tree: captures come grouped by kind,
              // so the last class read is not the member's in a file of several (M2-12 review).
              scope: kind === 'method' || kind === 'property' || kind === 'constant'
                ? phpEnclosingType(capture.node)?.childForFieldName('name')?.text ?? null
                : null,
              signature,
              startLine,
              endLine,
              metadata: {},
            };
            symbols.push(symbol);
            declarations.push([symbol, capture.node]);
          }
        }
      }

      // Each declaration by its node, labelled as the scanner names a source symbol (M2-13).
      const symbolByNodeId = new Map(declarations.map(([s, node]) => [node.id, s]));
      /**
       * Where a reference sits, from the syntax tree (M2-13): in a declaration on one line, that
       * declaration (`class User { public function name() { … } … }`: the method; `class B extends A`
       * beside `class A`: B), which the scanner's line ranges cannot tell from the others on the line,
       * as for C++ in M5-03-R2; in no declaration (`<?php echo tplf(); ?>` beside `function tplf()`),
       * the file, marked `fileLevel` so the line rule does not pick a declaration on its line. A
       * multi-line declaration is left to the line rule, which picks it.
       */
      const sourceOf = (node: any): { sourceSymbol: string | null; metadata?: Record<string, unknown> } => {
        for (let p = node.parent; p; p = p.parent) {
          const s = symbolByNodeId.get(p.id);
          if (s) return { sourceSymbol: s.startLine === s.endLine ? (s.scope ? `${s.scope}::${s.name}` : s.name) : null };
        }
        return { sourceSymbol: null, metadata: { fileLevel: true } };
      };

      // F05: Build UseImportTable
      const useTable = new Map<string, string>();
      // `use function App\fmt [as f]`: lower-cased local name → function FQN (M0-04-R5).
      const useFunctions = new Map<string, string>();
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

        // `use function` / `use const` import a function or constant: still an import, but never
        // in the class table (M0-04-R2).
        const declaration = parent?.type === 'namespace_use_group' ? parent.parent : parent;
        const isKeyword = (c: any) => c.type === 'function' || c.type === 'const';
        const importsClass = !node.children.some(isKeyword) && !declaration?.children.some(isKeyword);
        const isFunction = (c: any) => c.type === 'function';
        const importsFunction = node.children.some(isFunction) || !!declaration?.children.some(isFunction);

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
        if (importsClass) useTable.set(importName, fullTarget);
        // Function names are case-insensitive in PHP (M0-04-R5).
        if (importsFunction) useFunctions.set(importName.toLowerCase(), fullTarget.replace(/^\\/, ''));

        // Emit import reference; a function or constant import says so (M5-21: its external
        // reference is a function or constant, never a class).
        const isConst = !importsClass && !importsFunction;
        references.push({
          sourceSymbol: null,
          targetName: fullTarget,
          referenceType: 'import',
          startLine,
          verifiability: 'verified',
          ...(importsClass ? {} : { metadata: { phpUse: isConst ? 'const' : 'function' } }),
        });
      }

      const ELOQUENT_RELATIONSHIP_METHODS = new Set([
        'hasOne', 'hasMany', 'hasOneThrough', 'hasManyThrough',
        'belongsTo', 'belongsToMany',
        'morphTo', 'morphOne', 'morphMany', 'morphToMany', 'morphedByMany',
        'hasOneOfMany',
      ]);

      // PHP name resolution: `\X` is fully qualified; a first segment imported by `use` expands
      // (aliases and partial names like Contracts\Foo); anything else is relative to the namespace
      // in force where it is written. self/static/parent are never qualified.
      /**
       * The namespace in force at a node (M2-13 review): its enclosing `namespace X { … }` block,
       * else the last `namespace X;` statement before it, else the global one. Several blocks or
       * statements in one file, on one line or not, each name their own declarations.
       */
      let statements: Array<{ at: number; name: string }> | undefined;
      const namespaceAt = (node: any): string => {
        let root = node;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'namespace_definition' && p.childForFieldName('body')) return p.childForFieldName('name')?.text ?? '';
          root = p;
        }
        statements ??= (root.namedChildren ?? [])
          .filter((c: any) => c.type === 'namespace_definition' && !c.childForFieldName('body'))
          .map((c: any) => ({ at: c.startIndex, name: c.childForFieldName('name')?.text ?? '' }));
        let found = '';
        for (const s of statements!) if (s.at < node.startIndex) found = s.name;
        return found;
      };
      const resolveToFqn = (name: string, at: any): string => {
        if (name.startsWith('\\')) return name.substring(1);
        const [head, ...rest] = name.split('\\');
        if (useTable.has(head!)) return [useTable.get(head!)!, ...rest].join('\\');
        if (['self', 'static', 'parent'].includes(name.toLowerCase())) return name;
        const namespace = namespaceAt(at);
        return namespace ? `${namespace}\\${name}` : name;
      };

      // Attributes, named like classes, and PHPDoc tags (M5-10).
      for (const [symbol, node] of declarations) Object.assign(symbol.metadata, symbolAnnotations('php', node, (n: string) => resolveToFqn(n, node)));
      // A type or function's own namespace (M2-13 re-review): a file of several blocks or statements
      // declares in each, not in the file's last.
      for (const [symbol, node] of declarations) {
        if (PHP_NAMESPACED_KINDS.has(symbol.kind)) symbol.metadata.namespace = namespaceAt(node);
      }

      // The traits a class, trait or enum uses (`use HasUuid, \App\Logs;`), resolved like class
      // names: the architecture `mixes` selector reads them (M5-09).
      for (const [symbol, node] of declarations) {
        if (symbol.kind !== 'class' && symbol.kind !== 'trait' && symbol.kind !== 'enum') continue;
        const body = node.childForFieldName?.('body');
        const mixins = (body?.namedChildren ?? [])
          .filter((c: any) => c.type === 'use_declaration')
          .flatMap((u: any) => u.namedChildren.filter((n: any) => n.type === 'name' || n.type === 'qualified_name').map((n: any) => resolveToFqn(n.text, node)));
        if (mixins.length) symbol.metadata.mixins = mixins;
        // `use A, B { B::x insteadof A; A::x as ax; }` (M2-16 review): the winning trait of a method, and
        // the aliases that give a trait method another name; `as protected` alone changes visibility only.
        const traitRules = phpTraitRules(
          (body?.namedChildren ?? []).filter((c: any) => c.type === 'use_declaration').flatMap((u: any) => u.namedChildren.filter((n: any) => n.type === 'use_list')),
          (n: string) => resolveToFqn(n, node),
        );
        if (traitRules) symbol.metadata.traitRules = traitRules;
        // The class it extends, fully qualified: a method called on a new instance may be inherited (M2-12 review).
        const base = node.namedChildren.find((c: any) => c.type === 'base_clause')?.namedChildren.find((c: any) => c.type === 'name' || c.type === 'qualified_name');
        if (base && symbol.kind === 'class') symbol.metadata.bases = [resolveToFqn(base.text, node)];
      }

      // Process standard captures (extends, implements, calls, instantiations)
      for (const [captureName, captures] of refCaptures) {
        if (captureName === 'ref.target_use_clause') continue;
        if (
          captureName === 'ref.target_param' ||
          captureName === 'ref.target_return_type' ||
          captureName === 'ref.target_property' ||
          captureName === 'ref.target_dispatch' ||
          captureName === 'ref.target_dispatch_static' ||
          captureName === 'ref.target_notify' ||
          captureName === 'ref.target_function_call' ||
          captureName === 'ref.target_self_call' ||
          captureName === 'ref.target_require'
        ) {
          continue;
        }

        if (captureName.startsWith('ref.target_')) {
          const refType = captureName.replace('ref.target_', '');
          for (const capture of captures) {
            const targetName = capture.node.text;
            if (!targetName || typeof targetName !== 'string') continue;
            const startLine = capture.node.startPosition.row + 1;
            const cleaned = this.cleanTargetName(targetName, refType);
            const referenceType = this.mapRefType(refType);

            let verifiability: 'verified' | 'inferred' = 'verified';
            if (referenceType === 'call') {
              const parent = capture.node.parent;
              if (
                parent?.type === 'member_call_expression' &&
                parent.child(0)?.text === '$this' &&
                ELOQUENT_RELATIONSHIP_METHODS.has(cleaned)
              ) {
                continue;
              }
              const parentType = parent?.type;
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
              resolvedTarget = resolveToFqn(cleaned, capture.node);
            }

            // `(new Order())->total()`: the class whose method the scanner links (M2-12).
            let newClass: string | null = null;
            const call = capture.node.parent;
            if (referenceType === 'call' && call?.type === 'member_call_expression' && call.childForFieldName('name')?.id === capture.node.id) {
              let object = call.childForFieldName('object');
              while (object?.type === 'parenthesized_expression') object = object.namedChildren[0];
              const created = object?.type === 'object_creation_expression'
                ? object.namedChildren.find((c: any) => c.type === 'name' || c.type === 'qualified_name' || c.type === 'relative_scope') : null;
              const written = created?.text.toLowerCase();
              // `new self()` / `new static()`: the enclosing class; `new parent()`: the class it extends.
              const owner = written === 'self' || written === 'static' || written === 'parent' ? phpEnclosingType(created) : null;
              const ownerName = written === 'parent'
                ? owner?.namedChildren.find((c: any) => c.type === 'base_clause')?.namedChildren.find((c: any) => c.type === 'name' || c.type === 'qualified_name')?.text
                : owner?.childForFieldName('name')?.text;
              // `new parent()` in a class that extends nothing names no class either.
              if (created && owner && !ownerName && owner.type === 'class_declaration') continue;
              if (created) newClass = owner ? (ownerName ? resolveToFqn(ownerName, created) : null) : resolveToFqn(created.text, created);
              // `(new $cls())->m()`, `(new class { … })->m()`: a class the syntax does not name, so no
              // class to link and never a same-named method by name (review of M2-12).
              else if (object?.type === 'object_creation_expression') continue;
            }

            const source = sourceOf(capture.node);
            references.push({
              sourceSymbol: source.sourceSymbol,
              targetName: resolvedTarget,
              referenceType,
              startLine,
              verifiability,
              ...(newClass || source.metadata ? { metadata: { ...source.metadata, ...(newClass ? { newClass } : {}) } } : {}),
            });
          }
        }
      }

      // `self::m()`, `static::m()`, `parent::m()` (M2-16): a call of the method m of the class around
      // it (self, static: late static binding is not followed, so an override in a subclass is not
      // linked) or of its parent (parent). The scanner walks the class as for `new self()`: the class,
      // its traits, then its parent. `selfCall` makes a method the walk does not find link nothing,
      // where an unresolved `(new X())->m()` falls back to name lookup. A closure or arrow function
      // binds `self` to the class around it; an anonymous class is not that class (M2-22 owns it), and
      // outside any class `self` names nothing.
      for (const capture of refCaptures.get('ref.target_self_call') || []) {
        const call = capture.node.parent;
        const written = call?.childForFieldName('scope')?.text.toLowerCase();
        if (!call || (written !== 'self' && written !== 'static' && written !== 'parent')) continue;
        let owner: any = null;
        for (let p = call.parent; p; p = p.parent) {
          if (p.type === 'anonymous_class') break;
          if (PHP_TYPE_DECLARATIONS.has(p.type)) { owner = p; break; }
        }
        const ownerName = owner?.childForFieldName('name')?.text;
        if (!owner || !ownerName) continue;
        // The class the scanner's walk starts at: for self and static the class around the call, which
        // name lookup finds in this file first; for parent the class `extends` names.
        let start: string = ownerName;
        if (written === 'parent') {
          // Only a class has a parent; `class B` with no `extends` has none.
          const base = owner.type === 'class_declaration'
            ? owner.namedChildren.find((c: any) => c.type === 'base_clause')?.namedChildren.find((c: any) => c.type === 'name' || c.type === 'qualified_name')
            : null;
          if (!base) continue;
          start = resolveToFqn(base.text, owner);
        }
        const { sourceSymbol, metadata } = sourceOf(capture.node);
        references.push({
          sourceSymbol,
          targetName: capture.node.text,
          referenceType: 'call',
          startLine: capture.node.startPosition.row + 1,
          verifiability: 'verified',
          metadata: { ...metadata, newClass: start, selfCall: true },
        });
      }

      // Function calls, with the candidate FQNs in PHP's resolution order: `\X\f` is fully
      // qualified; `use function` names the function; a qualified name expands its first segment
      // through `use` or the current namespace; an unqualified name tries the current namespace,
      // then the global function (M0-04-R5).
      const functionCandidates = (raw: string, at: any): string[] => {
        const namespace = namespaceAt(at);
        if (raw.startsWith('\\')) return [raw.substring(1)];
        const relative = raw.match(/^namespace\\(.+)$/i)?.[1];
        if (relative) return [namespace ? `${namespace}\\${relative}` : relative];
        if (raw.includes('\\')) return [resolveToFqn(raw, at)];
        const imported = useFunctions.get(raw.toLowerCase());
        if (imported) return [imported];
        return namespace ? [`${namespace}\\${raw}`, raw] : [raw];
      };
      for (const capture of refCaptures.get('ref.target_function_call') || []) {
        const raw = capture.node.text;
        if (!raw) continue;
        const candidates = functionCandidates(raw, capture.node);
        const shortName = raw.split('\\').at(-1)!;
        const { sourceSymbol, metadata } = sourceOf(capture.node);
        references.push({
          sourceSymbol,
          targetName: candidates[0]!,
          referenceType: 'call',
          startLine: capture.node.startPosition.row + 1,
          verifiability: COMMON_FRAMEWORK_METHODS.has(shortName) ? 'inferred' : 'verified',
          phpFunction: candidates,
          ...(metadata ? { metadata } : {}),
        });
      }

      // require / include: string literals, __DIR__, dirname(__FILE__ | __DIR__) and `.`
      // concatenation. A __DIR__ path is emitted as `__DIR__/…` (relative to the including file),
      // a literal as written; variables and constants are not evaluated (M0-04-R5).
      const DIR = '\u0000DIR';
      const evalPath = (node: any): string | null => {
        switch (node.type) {
          case 'parenthesized_expression':
            return node.namedChildCount === 1 ? evalPath(node.namedChild(0)) : null;
          case 'string':
          case 'encapsed_string':
            // Interpolation and escape sequences are not evaluated.
            return node.namedChildren.every((c: any) => c.type === 'string_content')
              ? node.namedChildren.map((c: any) => c.text).join('')
              : null;
          case 'name':
            return node.text === '__DIR__' ? DIR : null;
          case 'function_call_expression': {
            if (node.childForFieldName('function')?.text !== 'dirname') return null;
            const args = (node.childForFieldName('arguments')?.namedChildren ?? []).filter((c: any) => c.type === 'argument');
            if (args.length !== 1) return null;
            const arg = args[0].text;
            return arg === '__FILE__' ? DIR : arg === '__DIR__' ? `${DIR}/..` : null;
          }
          case 'binary_expression': {
            if (node.child(1)?.text !== '.') return null;
            const left = evalPath(node.child(0));
            const right = evalPath(node.child(2));
            return left === null || right === null ? null : left + right;
          }
          default:
            return null;
        }
      };
      for (const capture of refCaptures.get('ref.target_require') || []) {
        const path = evalPath(capture.node);
        if (!path) continue;
        let target: string;
        if (path.startsWith(`${DIR}/`)) target = `__DIR__${path.substring(DIR.length)}`;
        else if (path.includes(DIR) || path.startsWith('/') || path.includes('://')) continue;
        else target = path;
        references.push({
          sourceSymbol: null,
          targetName: target,
          referenceType: 'require',
          startLine: capture.node.startPosition.row + 1,
          verifiability: 'verified',
        });
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
        'mixed', 'self', 'static', 'parent', 'false', 'true',
      ]);

      const processTypeHints = (capturesList: any[], edgeType: 'param_type' | 'return_type') => {
        for (const capture of capturesList) {
          const startLine = capture.node.startPosition.row + 1;
          const { className, methodName } = getEnclosingScope(capture.node);
          const sourceSymbol = methodName || className;

          const namedTypes = findNamedTypes(capture.node);
          for (const typeNode of namedTypes) {
            const typeText = typeNode.text;
            if (SCALAR_TYPES.has(typeText.toLowerCase())) continue;
            // Framework types (Illuminate\Http\Request, …) are external; app types named Request or
            // Response are not, so filter on the resolved name, not the short one.
            const resolved = resolveToFqn(typeText, typeNode);
            if (resolved.startsWith('Illuminate\\')) continue;
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

      // LARAVEL STRUCTURAL PATTERNS

      // F07: Eloquent Relationship Edges
      const RELATIONSHIP_TYPES: Record<string, string> = {
        hasOne: 'one-to-one',
        morphOne: 'one-to-one',
        hasMany: 'one-to-many',
        morphMany: 'one-to-many',
        hasOneThrough: 'one-to-many',
        hasManyThrough: 'one-to-many',
        belongsTo: 'many-to-one',
        morphTo: 'many-to-one',
        belongsToMany: 'many-to-many',
        morphToMany: 'many-to-many',
        morphedByMany: 'many-to-many',
      };

      const cleanQuotes = (str: string): string => {
        return str.replace(/^['"]|['"]$/g, '').trim();
      };

      const notComment = (c: any) => c.type !== 'comment';
      // The value node of argument `idx`; comments are not arguments (`bind(/* x */ Repo::class)`, M0-04-R2).
      const argValue = (argsNode: any, idx: number): any => {
        if (!argsNode || argsNode.type !== 'arguments') return null;
        const argNode = argsNode.namedChildren.filter(notComment)[idx];
        if (!argNode) return null;
        return argNode.type === 'argument' ? (argNode.namedChildren.find(notComment) || argNode) : argNode;
      };

      // The class a value names: `X::class` as written, or a string (single- or double-quoted).
      const classNameOf = (valNode: any): string | null => {
        if (valNode.type === 'class_constant_access_expression') {
          return valNode.namedChild(0)?.text ?? null;
        }
        if (valNode.type === 'string' || valNode.type === 'encapsed_string') {
          // A class name in a string is always fully qualified: mark it so resolveToFqn keeps it.
          const name = cleanQuotes(valNode.text).replace(/\\\\/g, '\\').replace(/^\\/, '');
          return name ? `\\${name}` : null;
        }
        return null;
      };

      const getArgText = (argsNode: any, idx: number): string | null => {
        const valNode = argValue(argsNode, idx);
        if (!valNode) return null;
        return classNameOf(valNode) ?? cleanQuotes(valNode.text);
      };

      const modelClasses = new Set<string>();
      const controllerClasses = new Set<string>();
      const serviceProviderClasses = new Set<string>();

      const relationMethodCaptures = refCaptures.get('ref.relation_method_name') || [];
      for (const cap of relationMethodCaptures) {
        const methodName = cap.node.text;
        if (!ELOQUENT_RELATIONSHIP_METHODS.has(methodName)) continue;

        const parent = cap.node.parent;
        if (!parent || parent.type !== 'member_call_expression') continue;

        const obj = parent.child(0);
        if (!obj || obj.text !== '$this') continue;

        const { className } = getEnclosingScope(cap.node);
        if (!className) continue;

        modelClasses.add(className);

        const argsNode = parent.namedChildren.find((c: any) => c.type === 'arguments');
        if (!argsNode) continue;
        const targetArgText = getArgText(argsNode, 0);
        if (targetArgText) {
          const targetFqn = resolveToFqn(targetArgText, cap.node);
          const startLine = cap.node.startPosition.row + 1;
          const isClassConst = argValue(argsNode, 0)?.type === 'class_constant_access_expression';

          references.push({
            sourceSymbol: className,
            targetName: targetFqn,
            referenceType: 'relation',
            startLine,
            verifiability: isClassConst ? 'verified' : 'inferred',
            metadata: {
              relationshipMethod: methodName,
              relationshipType: RELATIONSHIP_TYPES[methodName] || 'one-to-many',
            },
          });
        }
      }

      // F08: Route-to-Controller Binding Edges refactored to LaravelDetector
      // F09: Service Container Binding Resolution
      const CONTAINER_BINDING_METHODS = new Set(['bind', 'singleton', 'scoped', 'instance', 'alias']);
      const bindingMethodCaptures = refCaptures.get('ref.binding_method_name') || [];

      for (const cap of bindingMethodCaptures) {
        const methodName = cap.node.text;
        if (!CONTAINER_BINDING_METHODS.has(methodName)) continue;

        const parent = cap.node.parent;
        if (!parent || parent.type !== 'member_call_expression') continue;

        const obj = parent.child(0);
        if (!obj) continue;
        const objText = obj.text;
        const isApp = objText.startsWith('$this->app') || objText === '$app' || objText.startsWith('app(');
        if (!isApp) continue;

        const { className, methodName: encMethod } = getEnclosingScope(cap.node);
        if (className) {
          serviceProviderClasses.add(className);
        }

        const argsNode = parent.namedChildren.find((c: any) => c.type === 'arguments');
        if (!argsNode) continue;
        const abstractVal = getArgText(argsNode, 0);
        if (abstractVal) {
          const concreteVal = getArgText(argsNode, 1);
          const abstractFqn = resolveToFqn(abstractVal, cap.node);
          // Only a class constant (Concrete::class) or a class-name string names a concrete class;
          // a closure or factory is not one.
          const valNode1 = argValue(argsNode, 1);
          const namesClass = !!valNode1 && classNameOf(valNode1) !== null;
          const concreteFqn = concreteVal && namesClass ? resolveToFqn(concreteVal, cap.node) : null;
          const startLine = cap.node.startPosition.row + 1;
          const isAbstractClassConst = argValue(argsNode, 0)?.type === 'class_constant_access_expression';

          references.push({
            sourceSymbol: encMethod || 'register',
            targetName: abstractFqn,
            referenceType: 'binding',
            startLine,
            verifiability: isAbstractClassConst ? 'verified' : 'inferred',
            metadata: {
              bindingType: methodName,
              concreteClass: concreteFqn,
              serviceProviderPhase: encMethod === 'boot' ? 'boot' : 'register',
            },
          });
        }
      }

      // F12: Event, Job, and Notification dispatches
      const targetDispatchCaptures = refCaptures.get('ref.target_dispatch') || [];
      for (const cap of targetDispatchCaptures) {
        const targetRaw = cap.node.text;
        const targetFqn = resolveToFqn(targetRaw, cap.node);
        const startLine = cap.node.startPosition.row + 1;
        const { methodName } = getEnclosingScope(cap.node);
        
        let curr: any = cap.node;
        let fnName = 'dispatch';
        while (curr) {
          if (curr.type === 'function_call_expression') {
            fnName = curr.childForFieldName('function')?.text || 'dispatch';
            break;
          }
          curr = curr.parent;
        }

        const dispatchedRole = fnName === 'event' ? 'event' : 'job';

        references.push({
          sourceSymbol: methodName,
          targetName: targetFqn,
          referenceType: 'dispatch',
          startLine,
          verifiability: 'verified',
          metadata: {
            dispatchMethod: fnName,
            dispatchedRole,
          }
        });
      }

      const targetDispatchStaticCaptures = refCaptures.get('ref.target_dispatch_static') || [];
      for (const cap of targetDispatchStaticCaptures) {
        const targetRaw = cap.node.text;
        const targetFqn = resolveToFqn(targetRaw, cap.node);
        const startLine = cap.node.startPosition.row + 1;
        const { methodName } = getEnclosingScope(cap.node);

        let curr: any = cap.node;
        let methodCallName = 'dispatch';
        while (curr) {
          if (curr.type === 'scoped_call_expression') {
            methodCallName = curr.childForFieldName('name')?.text || 'dispatch';
            break;
          }
          curr = curr.parent;
        }

        // Event::dispatch(new X) / Bus::dispatch(new X): the facade is only the channel; the
        // dispatched class is the `new` argument.
        const facadeChannel = /^(?:\\?Illuminate\\Support\\Facades\\)?(Event|Bus|Queue)$/.exec(targetFqn) || /^(Event|Bus|Queue)$/.exec(targetRaw);
        if (facadeChannel) {
          const call = curr?.type === 'scoped_call_expression' ? curr : null;
          const created = call?.childForFieldName('arguments')?.descendantsOfType?.('object_creation_expression')?.[0];
          const createdName = created?.namedChildren?.find((c: any) => c.type === 'name' || c.type === 'qualified_name')?.text;
          if (!createdName) continue;
          references.push({
            sourceSymbol: methodName,
            targetName: resolveToFqn(createdName, cap.node),
            referenceType: 'dispatch',
            startLine,
            verifiability: 'verified',
            metadata: {
              dispatchMethod: `${facadeChannel[1]}::${methodCallName}`,
              dispatchedRole: facadeChannel[1] === 'Event' ? 'event' : 'job',
            }
          });
          continue;
        }

        references.push({
          sourceSymbol: methodName,
          targetName: targetFqn,
          referenceType: 'dispatch',
          startLine,
          verifiability: 'verified',
          metadata: {
            dispatchMethod: methodCallName,
            dispatchedRole: 'job',
          }
        });
      }

      // EventServiceProvider: protected $listen = [Event::class => [Listener::class, …]]
      // File-level edges originate here, so each listener gets a `binding` edge from the provider
      // carrying the event it handles (F12 stretch goal). Read from the property's syntax tree, so a
      // docblock example or a commented-out listener is ignored, and an event or listener may be
      // `X::class` or a class-name string (M0-04-R2).
      for (const cap of refCaptures.get('ref.target_property') || []) {
        const element = cap.node.namedChildren.find((c: any) => c.type === 'property_element');
        const variable = element?.namedChildren.find((c: any) => c.type === 'variable_name');
        if (!element || variable?.text !== '$listen') continue;
        const array = element.namedChildren.find((c: any) => c.type === 'array_creation_expression');
        for (const entry of array?.namedChildren.filter((c: any) => c.type === 'array_element_initializer') ?? []) {
          const [key, value] = entry.namedChildren.filter(notComment);
          const event = key && value ? classNameOf(key) : null;
          if (!event) continue;
          const listeners = value.type === 'array_creation_expression'
            ? value.namedChildren.filter((c: any) => c.type === 'array_element_initializer').map((c: any) => c.namedChildren.find(notComment))
            : [value];
          for (const listenerNode of listeners) {
            // 'App\Listeners\X@handle' names the class X.
            const listener = listenerNode ? classNameOf(listenerNode)?.replace(/@\w*$/, '') : null;
            if (!listener) continue;
            references.push({
              sourceSymbol: null,
              targetName: resolveToFqn(listener, key),
              referenceType: 'binding',
              startLine: key.startPosition.row + 1,
              verifiability: listenerNode.type === 'class_constant_access_expression' ? 'verified' : 'inferred',
              metadata: { bindingType: 'listen', event: resolveToFqn(event, key) },
            });
          }
        }
      }

      const targetNotifyCaptures = refCaptures.get('ref.target_notify') || [];
      for (const cap of targetNotifyCaptures) {
        const targetRaw = cap.node.text;
        const targetFqn = resolveToFqn(targetRaw, cap.node);
        const startLine = cap.node.startPosition.row + 1;
        const { methodName } = getEnclosingScope(cap.node);

        let curr: any = cap.node;
        let sendMethod = 'notify';
        while (curr) {
          if (curr.type === 'member_call_expression') {
            sendMethod = curr.childForFieldName('name')?.text || 'notify';
            break;
          }
          if (curr.type === 'scoped_call_expression') {
            const scope = curr.childForFieldName('scope')?.text;
            const name = curr.childForFieldName('name')?.text;
            if (scope === 'Notification') {
              sendMethod = `Notification::${name}`;
              break;
            }
          }
          curr = curr.parent;
        }

        references.push({
          sourceSymbol: methodName,
          targetName: targetFqn,
          referenceType: 'notify',
          startLine,
          verifiability: 'verified',
          metadata: {
            sendMethod,
          }
        });
      }

      // Collect extend-based classes and resolve roles on symbols
      const classExtends = new Map<string, string>();
      const classImplements = new Map<string, string[]>();
      const classesWithHandle = new Set<string>();

      for (const sym of symbols) {
        if (sym.kind === 'method' && sym.name === 'handle' && sym.scope) {
          classesWithHandle.add(sym.scope);
        }
      }

      const extendsCapList = refCaptures.get('ref.target_extends') || [];
      for (const ext of extendsCapList) {
        const { className } = getEnclosingScope(ext.node);
        if (!className) continue;
        const extText = ext.node.text;
        classExtends.set(className, extText);

        if (
          extText === 'Model' || extText === 'Authenticatable' || extText === 'Pivot' ||
          extText.endsWith('\\Model') || extText.endsWith('\\Authenticatable') || extText.endsWith('\\Pivot')
        ) {
          modelClasses.add(className);
        }
        if (
          extText === 'Controller' || extText === 'BaseController' ||
          extText.endsWith('\\Controller') || extText.endsWith('\\BaseController')
        ) {
          controllerClasses.add(className);
        }
        if (
          extText === 'ServiceProvider' ||
          extText.endsWith('\\ServiceProvider')
        ) {
          serviceProviderClasses.add(className);
        }
      }

      const implementsCapList = refCaptures.get('ref.target_implements') || [];
      for (const imp of implementsCapList) {
        const { className } = getEnclosingScope(imp.node);
        if (!className) continue;
        const impText = imp.node.text;
        if (!classImplements.has(className)) {
          classImplements.set(className, []);
        }
        classImplements.get(className)!.push(impText);
      }

      // F12: Detect Laravel Roles (event, job, notification, listener)
      const eventClasses = new Set<string>();
      const jobClasses = new Set<string>();
      const notificationClasses = new Set<string>();
      const listenerClasses = new Set<string>();

      for (const sym of symbols) {
        if (sym.kind === 'class') {
          const className = sym.name;
          const extText = classExtends.get(className);
          const imps = classImplements.get(className) || [];

          // Heuristic checks
          const isEvent = filePath.includes('/Events/') || className.endsWith('Event') || imps.includes('ShouldBroadcast') || imps.includes('ShouldBroadcastNow');
          const isJob = filePath.includes('/Jobs/') || className.endsWith('Job') || imps.includes('ShouldQueue') || imps.includes('ShouldBeUnique');
          const isNotification = filePath.includes('/Notifications/') || className.endsWith('Notification') || extText === 'Notification' || extText?.endsWith('\\Notification');
          const isListener = filePath.includes('/Listeners/') || className.endsWith('Listener') || (classesWithHandle.has(className) && (imps.includes('ShouldQueue') || filePath.includes('/Listeners/')));

          if (isEvent) eventClasses.add(className);
          else if (isJob) jobClasses.add(className);
          else if (isNotification) notificationClasses.add(className);
          else if (isListener) listenerClasses.add(className);
        }
      }

      for (const sym of symbols) {
        if (sym.kind === 'class') {
          if (modelClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'model';
          } else if (controllerClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'controller';
          } else if (serviceProviderClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'service_provider';
          } else if (eventClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'event';
          } else if (jobClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'job';
          } else if (notificationClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'notification';
          } else if (listenerClasses.has(sym.name)) {
            sym.metadata.laravelRole = 'listener';
          }
        }
      }

      // Check if file is a route file
      const isRouteFile = filePath.replace(/\\/g, '/').includes('routes/');
      if (isRouteFile) {
        // Keep the namespace: class resolution reads it (M0-04-R2).
        fileMetadata = { ...fileMetadata, laravelRole: 'route_file' };
      }

      // F10: Classification of migration, seeder, and factory roles
      let isMigration = filePath.includes('/migrations/');
      let isSeeder = filePath.includes('/seeders/');
      let isFactory = filePath.includes('/factories/');

      for (const ext of extendsCapList) {
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
    } finally {
      // The nodes are read; free the tree (M2-08-R9).
      parsed?.dispose();
    }

    // F12: Suppress duplicate instantiation/call references for specific dispatch/notify targets
    const specificTargets = new Set<string>();
    for (const ref of references) {
      if (ref.referenceType === 'dispatch' || ref.referenceType === 'notify') {
        specificTargets.add(`${ref.targetName}:${ref.startLine}`);
      }
    }

    const finalReferences = references.filter(ref => {
      if (ref.referenceType === 'instantiation' || ref.referenceType === 'call') {
        if (specificTargets.has(`${ref.targetName}:${ref.startLine}`)) {
          return false;
        }
      }
      return true;
    });

    // F11: Laravel Facade Resolution
    const mergedFacadeMap = {
      ...LARAVEL_FACADE_MAP,
      ...(options?.facadeMap || {}),
    };

    for (const ref of finalReferences) {
      if (!ref.targetName || typeof ref.targetName !== 'string') continue;
      if (ref.phpFunction) continue; // a function call is never a facade
      if (ref.referenceType === 'call' || ref.referenceType === 'instantiation') {
        const shortName = ref.targetName.split('\\').at(-1) ?? ref.targetName;
        // Only a real facade reference is rewritten: the facade class itself, or a global alias
        // (unqualified in a non-namespaced file). An imported or same-namespace class named
        // Cache/Event/Response is the app's own class.
        const isFacadeReference = ref.targetName === shortName || ref.targetName === `Illuminate\\Support\\Facades\\${shortName}`;
        if (shortName !== 'Route' && isFacadeReference) {
          // Own keys only: `$x->toString()` read Object.prototype.toString, a function, as the facade's
          // class; that dropped the call and failed every parallel scan reaching it (M0-06-R2).
          const resolved = Object.hasOwn(mergedFacadeMap, shortName) ? mergedFacadeMap[shortName] : undefined;
          if (typeof resolved === 'string' && resolved) {
            // The class the file names (`\Cache` is the global alias even in a namespaced file),
            // kept for its external reference (M5-21 review).
            const facadeClass = ref.targetName;
            ref.targetName = resolved;
            ref.verifiability = 'inferred';
            ref.metadata = {
              ...ref.metadata,
              facadeAlias: shortName,
              facadeClass,
              isRawDbAccess: shortName === 'DB',
            };
          }
        }
      }
    }

    return { symbols, references: finalReferences, errors, fileMetadata, ...(ambient ? { ambient } : {}) };
  }

  protected override extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
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

  protected override mapRefType(refType: string): ExtractedReference['referenceType'] {
    const map: Record<string, ExtractedReference['referenceType']> = {
      import: 'import',
      require: 'require',
      extends: 'extends',
      implements: 'implements',
      call: 'call',
      instantiation: 'instantiation',
      dispatch: 'dispatch',
      notify: 'notify',
    };
    return map[refType] || 'call';
  }
}
