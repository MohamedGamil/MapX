import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from '../wasm-parser.js';
import { COMMON_FRAMEWORK_METHODS } from '../common-methods.js';
import { GenericWasmParser } from '../generic-wasm-parser.js';

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

            if (kind === 'namespace') {
              if (!fileMetadata) fileMetadata = {};
              fileMetadata.namespace = name;
              continue;
            }

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

      const ELOQUENT_RELATIONSHIP_METHODS = new Set([
        'hasOne', 'hasMany', 'hasOneThrough', 'hasManyThrough',
        'belongsTo', 'belongsToMany',
        'morphTo', 'morphOne', 'morphMany', 'morphToMany', 'morphedByMany',
        'hasOneOfMany',
      ]);

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
          captureName === 'ref.target_property' ||
          captureName === 'ref.target_dispatch' ||
          captureName === 'ref.target_dispatch_static' ||
          captureName === 'ref.target_notify'
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

      const getArgText = (argsNode: any, idx: number): string | null => {
        if (!argsNode || argsNode.type !== 'arguments') return null;
        const argNode = argsNode.namedChild(idx);
        if (!argNode) return null;
        const valNode = argNode.type === 'argument' ? (argNode.namedChild(0) || argNode) : argNode;
        if (valNode.type === 'class_constant_access_expression') {
          const classNode = valNode.namedChild(0);
          if (classNode) return classNode.text;
        }
        return cleanQuotes(valNode.text);
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
          const targetFqn = resolveToFqn(targetArgText);
          const startLine = cap.node.startPosition.row + 1;
          
          const arg0 = argsNode.namedChild(0);
          if (arg0) {
            const valNode = arg0.type === 'argument' ? (arg0.namedChild(0) || arg0) : arg0;
            const isClassConst = valNode ? valNode.type === 'class_constant_access_expression' : false;

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
          const abstractFqn = resolveToFqn(abstractVal);
          const concreteFqn = concreteVal ? resolveToFqn(concreteVal) : null;
          const startLine = cap.node.startPosition.row + 1;

          const arg0 = argsNode.namedChild(0);
          if (arg0) {
            const valNode0 = arg0.type === 'argument' ? (arg0.namedChild(0) || arg0) : arg0;
            const isAbstractClassConst = valNode0 ? valNode0.type === 'class_constant_access_expression' : false;

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
      }

      // F12: Event, Job, and Notification dispatches
      const targetDispatchCaptures = refCaptures.get('ref.target_dispatch') || [];
      for (const cap of targetDispatchCaptures) {
        const targetRaw = cap.node.text;
        const targetFqn = resolveToFqn(targetRaw);
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
        const targetFqn = resolveToFqn(targetRaw);
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

      const targetNotifyCaptures = refCaptures.get('ref.target_notify') || [];
      for (const cap of targetNotifyCaptures) {
        const targetRaw = cap.node.text;
        const targetFqn = resolveToFqn(targetRaw);
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
        fileMetadata = { laravelRole: 'route_file' };
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
      if (ref.referenceType === 'call' || ref.referenceType === 'instantiation') {
        const shortName = ref.targetName.split('\\').at(-1) ?? ref.targetName;
        if (shortName !== 'Route') {
          const resolved = mergedFacadeMap[shortName];
          if (resolved) {
            ref.targetName = resolved;
            ref.verifiability = 'inferred';
            ref.metadata = {
              ...ref.metadata,
              facadeAlias: shortName,
              isRawDbAccess: shortName === 'DB',
            };
          }
        }
      }
    }

    return { symbols, references: finalReferences, errors, fileMetadata };
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
