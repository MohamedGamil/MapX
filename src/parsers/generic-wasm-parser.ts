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

/**
 * True when a JS/TS node sits inside a function, arrow or method body (M0-17-R3), or in a block:
 * `if (x) { const f = () => 1 }` is block-scoped (M0-17-R5). A TypeScript namespace body is
 * module level.
 */
function insideFunctionOrBlock(node: any): boolean {
  for (let curr = node.parent; curr; curr = curr.parent) {
    if (JS_FUNCTION_NODES.has(curr.type)) return true;
    if (curr.type === 'statement_block' && curr.parent?.type !== 'internal_module' && curr.parent?.type !== 'module') return true;
    if (curr.type === 'switch_case' || curr.type === 'switch_default' || curr.type === 'for_statement') return true;
  }
  return false;
}

/**
 * Values that make a module-level binding callable (M0-17-R5): a call (`create(…)`,
 * `createAsyncThunk(…)`, `functools.partial(…)`), a name (`= useSelector`), a member
 * (`= store.dispatch`) or a Python lambda. Literals, objects, arrays, operators and `new` stay
 * values.
 */
const CALLABLE_VALUES = new Set(['call_expression', 'identifier', 'member_expression', 'call', 'attribute', 'lambda']);
const TRANSPARENT_VALUES = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression']);

/**
 * Whether a module-level binding to a call, a name or a member is meant to be called (M0-17-R6): the
 * file calls it by name, or it is exported for other modules to (`export const`, `export { … }`,
 * `module.exports` / `exports.x`; in Python, any public name). `const app = createApp(App)` used
 * as `app.mount()` stays a value.
 */
function usedAsFunction(node: any, source: string): boolean {
  const python = node.type === 'expression_statement';
  const name: string | undefined = python
    ? node.namedChildren[0]?.childForFieldName('left')?.text
    : node.childForFieldName('name')?.text;
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return true;
  if (python && !name.startsWith('_')) return true;
  const facts = sourceFacts(source);
  if (facts.called.has(name)) return true;
  if (python) return false;
  for (let p = node.parent; p; p = p.parent) if (p.type === 'export_statement') return true;
  return facts.exported.has(name);
}

/**
 * Per source text (the last one parsed): the names it calls (`f(`, `f?.(`, `f.call(` / `.apply(` /
 * `.bind(`) and those it exports by name (`export { a, b as c }`, `export default a`, `export = a`,
 * `module.exports`, `exports.a` / `exports.default`) (M0-17-R6, review 2026-11-01).
 */
let factsFor: { source: string; called: Set<string>; exported: Set<string> } | null = null;
function sourceFacts(source: string): { called: Set<string>; exported: Set<string> } {
  if (factsFor?.source === source) return factsFor;
  const called = new Set<string>();
  for (const m of source.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?(?:\(|\.\s*(?:call|apply|bind)\s*\()/g)) called.add(m[1]!);
  const exported = new Set<string>();
  for (const m of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const local = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(part)?.[1];
      if (local) exported.add(local);
    }
  }
  for (const m of source.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*[;\n]|\bexport\s*=\s*([A-Za-z_$][\w$]*)|\bexports\.(?:default|[A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)|\bexports\.([A-Za-z_$][\w$]*)\b/g)) {
    exported.add((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  }
  for (const m of source.matchAll(/\bmodule\.exports\b([^;]*)/g)) {
    for (const w of m[1]!.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g)) exported.add(w[1]!);
  }
  factsFor = { source, called, exported };
  return factsFor;
}

/** The value of a JS/TS declarator or a module-level Python assignment, unwrapped; null otherwise. */
function bindingValue(node: any): any {
  let value = node.type === 'variable_declarator' ? node.childForFieldName('value')
    : node.type === 'expression_statement' && node.parent?.type === 'module' && node.namedChildren[0]?.type === 'assignment'
      ? node.namedChildren[0].childForFieldName('right')
      : null;
  while (value && TRANSPARENT_VALUES.has(value.type)) value = value.namedChildren[0];
  return value ?? null;
}

const LOCAL_SCOPE_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'python']);
const CALL_NODES = new Set(['call_expression', 'call', 'new_expression']);

/**
 * True when a JS/TS or Python parameter list declares `name` as a plain parameter (with a type,
 * default or rest). Destructured parameters are not followed: `({ loadLanguage }) => …` over a
 * dynamic import names the module's function.
 */
function bindsName(n: any, name: string): boolean {
  switch (n?.type) {
    case 'identifier': return n.text === name;
    case 'required_parameter': case 'optional_parameter': return bindsName(n.childForFieldName('pattern'), name);
    case 'assignment_pattern': return bindsName(n.childForFieldName('left'), name);
    case 'default_parameter': case 'typed_default_parameter': return bindsName(n.childForFieldName('name'), name);
    case 'formal_parameters': case 'parameters': case 'lambda_parameters':
    case 'rest_pattern': case 'typed_parameter': case 'list_splat_pattern': case 'dictionary_splat_pattern':
      return n.namedChildren.some((c: any) => c.type !== 'type' && c.type !== 'type_annotation' && bindsName(c, name));
    default: return false;
  }
}

/**
 * True when `name()` at `node` calls a parameter or a plain local variable of an enclosing JS/TS
 * function or block, or Python function (M0-17-R5). Such a call never reaches a module symbol of
 * that name, which is now often a function (`const useAppSelector = useSelector`): the guard
 * M0-17-R2 had from skipping constants. Destructured locals (`const { reset } = useStore()`) are
 * left to the Vue store and composable passes.
 */
function boundLocally(node: any, name: string): boolean {
  for (let curr = node.parent; curr && curr.type !== 'program' && curr.type !== 'module'; curr = curr.parent) {
    const params = curr.type === 'arrow_function' && !curr.childForFieldName('parameters')
      ? curr.childForFieldName('parameter') : curr.childForFieldName('parameters');
    if ((JS_FUNCTION_NODES.has(curr.type) || curr.type === 'function_definition' || curr.type === 'lambda') && bindsName(params, name)) return true;
    const jsBlock = curr.type === 'statement_block' && curr.parent?.type !== 'internal_module' && curr.parent?.type !== 'module';
    const pyBody = curr.type === 'block' && curr.parent?.type === 'function_definition';
    if (!jsBlock && !pyBody) continue;
    for (const s of curr.namedChildren) {
      if ((s.type === 'lexical_declaration' || s.type === 'variable_declaration')
        && s.namedChildren.some((d: any) => d.type === 'variable_declarator' && d.childForFieldName('name')?.type === 'identifier' && d.childForFieldName('name').text === name)) return true;
      const assignment = s.type === 'expression_statement' ? s.namedChildren[0] : null;
      if (pyBody && assignment?.type === 'assignment' && assignment.childForFieldName('left')?.type === 'identifier' && assignment.childForFieldName('left').text === name) return true;
    }
  }
  return false;
}

/**
 * Go `struct { log.Logger }`: the import path of the package qualifying an embedded type, by
 * import alias or package name (the last path element without a `.vN`, `vN` or `go-` decoration).
 * When no import matches by name, the unaliased imports are returned as candidates: a package's
 * name need not be its last path element (`api/v1` declaring `package v1`, `internal/db` declaring
 * `package database`); the scanner keeps the one project package that declares the type
 * (review 2026-11-02). Null when there is no candidate (M0-17-R5).
 */
function goImportPath(qualifiedType: any): string | string[] | null {
  const qualifier = qualifiedType.childForFieldName('package')?.text;
  let root = qualifiedType;
  while (root.parent) root = root.parent;
  const specs: any[] = [];
  const collect = (n: any) => {
    for (const c of n.namedChildren) {
      if (c.type === 'import_spec') specs.push(c);
      else if (c.type === 'import_declaration' || c.type === 'import_spec_list') collect(c);
    }
  };
  collect(root);
  const candidates: string[] = [];
  for (const spec of specs) {
    const path = String(spec.childForFieldName('path')?.text ?? '').replace(/^["`]|["`]$/g, '');
    const alias = spec.childForFieldName('name')?.text;
    const parts = path.split('/');
    const last = /^v\d+$/.test(parts[parts.length - 1] ?? '') && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1];
    const name = (last ?? '').replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/-go$/, '');
    if ((alias ?? name) === qualifier) return path;
    if (!alias && path) candidates.push(path);
  }
  return candidates.length ? candidates : null;
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
            let kind = baseKind;
            // A `const f = () => …` declarator is a function, claimed by the function pattern on
            // the same node: skip it here without marking it seen (M0-17-R1).
            if ((baseKind === 'constant' || baseKind === 'variable') && capture.node.type === 'variable_declarator') {
              const value = capture.node.childForFieldName('value')?.type;
              if (value === 'arrow_function' || value === 'function_expression' || value === 'function' || value === 'generator_function') continue;
              // `export const Klass = class {}` is a class named by its binding (M0-17-R5).
              if (value === 'class') kind = 'class';
            }
            // A module-level binding to a call, a name or a member is callable, so it is a
            // function symbol and a call target; only a literal value stays a constant or
            // variable (M0-17-R5). Not in a Vue SFC: there `const total = computed(…)` is a reactive
            // value, and value declarations own no references (vue-template.ts, rule 2).
            if ((kind === 'constant' || kind === 'variable') && !filePath.endsWith('.vue')
              && CALLABLE_VALUES.has(bindingValue(capture.node)?.type) && usedAsFunction(capture.node, source)) kind = 'function';
            // A `const f = () => …` inside a function, method or block is a local binding, like a
            // local constant, not a module function (M0-17-R3, M0-17-R5).
            if (baseKind === 'function' && capture.node.type === 'variable_declarator' && insideFunctionOrBlock(capture.node)) continue;
            seenNodeIds.add(capture.node.id);

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
            // (`Box<T>::f` → Box) (M0-17-R2). The name is the innermost one at any depth
            // (`a::b::c::D::g` → g), a destructor keeping its tilde (`ns::K::~K` → ~K) (M0-17-R5).
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
              const leaf = qualified?.type === 'qualified_identifier' ? qualified.childForFieldName('name') : null;
              if (leaf) {
                name = leaf.type === 'destructor_name' ? leaf.text.replace(/\s+/g, '')
                  : leaf.type === 'template_function' ? (leaf.childForFieldName('name')?.text ?? leaf.text) : leaf.text;
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

            // `fetchUser()` on a parameter or local variable is not the module's `fetchUser` (M0-17-R5).
            if ((referenceType === 'call' || referenceType === 'instantiation') && LOCAL_SCOPE_LANGUAGES.has(this.languageName)
              && !filePath.endsWith('.vue') && capture.node.type === 'identifier'
              && CALL_NODES.has(capture.node.parent?.type ?? '') && boundLocally(capture.node, targetName)) continue;

            // Go `struct { log.Logger }`: the embedded type lives in the imported package, which the
            // scanner resolves; a library package (null when no import matches) links nothing (M0-17-R5).
            const goPackage = this.languageName === 'go' && referenceType === 'extends' && capture.node.parent?.type === 'qualified_type'
              ? { goPackage: goImportPath(capture.node.parent) } : null;

            references.push({
              sourceSymbol: null,
              targetName,
              referenceType,
              startLine,
              verifiability,
              // The receiver of a member call (`obj`, `this`, `super`, `a.b`), for the scanner to tell a
              // library object and never take the call for a global function (M0-17-R4).
              ...(referenceType === 'call' && receiver ? { metadata: { receiver: receiver.type === 'identifier' ? receiver.text : `<${receiver.type}>` } } : {}),
              // The import path of a package-qualified Go embedded type (an extends, never a call) (M0-17-R5).
              ...(goPackage ? { metadata: goPackage } : {}),
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
