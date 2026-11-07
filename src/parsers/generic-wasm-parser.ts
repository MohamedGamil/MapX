import type { LanguageParser } from './parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference, SymbolKind } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { loadLanguage, loadQueryFile, parseWithQueries } from './wasm-parser.js';
import { ambientAccesses } from './ambient.js';
import { COMMON_FRAMEWORK_METHODS, JS_BUILTIN_METHODS, JS_BUILTIN_RECEIVERS } from './common-methods.js';
import { LuaScopes, luaCallTarget } from './languages/lua.js';
import { symbolAnnotations } from './annotations.js';
import { builtinModules } from 'node:module';

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

/** A C# namespace or Scala package clause, and the body its declarations sit in when it has one. */
function namespaceName(node: any): string | null {
  if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') return node.childForFieldName('name')?.text ?? null;
  if (node.type === 'package_clause') return node.namedChildren.find((c: any) => c.type === 'package_identifier')?.text ?? null;
  return null;
}

/**
 * The namespace a C# or Scala declaration is in, from the syntax tree (M5-03-R2): the file-level
 * clauses (`namespace X;`, `package a`), then each enclosing block (`namespace A { … }`,
 * `package b { … }`), joined with dots. '' for a declaration outside every one, in the global
 * namespace. Line ranges cannot tell this for blocks on one line, nested Scala packages or a type
 * after the blocks.
 */
function declaredNamespace(node: any): string {
  const blocks: string[] = [];
  let root = node;
  for (let p = node.parent; p; p = p.parent) {
    const name = namespaceName(p);
    if (name) blocks.unshift(name);
    root = p;
  }
  const clauses: string[] = [];
  for (const c of root.namedChildren) {
    const name = c.type === 'file_scoped_namespace_declaration' || (c.type === 'package_clause' && !c.namedChildren.some((b: any) => b.type === 'template_body'))
      ? namespaceName(c) : null;
    // Clauses before the declaration; one that encloses it is an ancestor, already in `blocks`.
    if (name && c.endIndex <= node.startIndex) clauses.push(name);
  }
  return [...clauses, ...blocks].join('.');
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

/** The specifier of a JS/TS `require('s')` call node, or null (M2-20). */
function requireSpecifier(node: any): string | null {
  if (node?.type !== 'call_expression' || node.childForFieldName('function')?.text !== 'require') return null;
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  return args.length === 1 && args[0].type === 'string' ? String(args[0].text).slice(1, -1) : null;
}

/** Whether a JS/TS node sits in no function or class: a top-level `require` is the file's, as an import is (M2-20). */
function outsideFunctions(node: any): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (/function|method|arrow|class|generator/.test(p.type)) return false;
  }
  return true;
}

/**
 * The class a method call's receiver instantiates (M2-12): `new Order().total()` in JS/TS (`Order`,
 * `ns.Order`; type arguments are a separate field), Java and C# (`Order`, generics and qualifiers
 * dropped), and Python `Order().total()` (a CapWords name, as the instantiation query reads it).
 * Parentheses around the receiver are looked through. Null for a new instance whose class the
 * syntax does not name (`new (getClass())()`, `new reg[0]()`); undefined for any other call: a
 * chained `new A().b().c()` has no known receiver type for `c`.
 */
function newReceiverClass(node: any, language: string): string | null | undefined {
  const call = node.parent;
  const field = call?.type === 'member_expression' ? ['object', 'property']
    : call?.type === 'attribute' ? ['object', 'attribute']
      : call?.type === 'method_invocation' ? ['object', 'name']
        : call?.type === 'member_access_expression' ? ['expression', 'name'] : null;
  if (!field || call.childForFieldName(field[1])?.id !== node.id) return undefined;
  let object = call.childForFieldName(field[0]);
  while (object?.type === 'parenthesized_expression') object = object.namedChildren[0];
  if (object?.type === 'new_expression') {
    const constructor = object.childForFieldName('constructor');
    return constructor?.type === 'identifier' || constructor?.type === 'member_expression' ? constructor.text : null;
  }
  if (object?.type === 'object_creation_expression' && (language === 'java' || language === 'c-sharp')) {
    const name = String(object.childForFieldName('type')?.text ?? '').replace(/<[\s\S]*$/, '').split('.').pop()!.trim();
    return /^[A-Za-z_]\w*$/.test(name) ? name : null;
  }
  if (object?.type === 'call' && language === 'python') {
    const fn = object.childForFieldName('function');
    return fn?.type === 'identifier' && /^[A-Z]/.test(fn.text) ? fn.text : undefined;
  }
  return undefined;
}

/**
 * The types a class declaration names as its bases, as written (reviews of M2-12), for the walk of a
 * method called on a new instance: `class Sub extends Base` (JS/TS, `ns.Base` too), the Java
 * superclass then its interfaces (default methods), every entry of a C# base list, every Python
 * base (`class Sub(Base, mod.Mixin)`). `?` stands for a base the syntax does not name
 * (`extends Timestamped(Plain)`, `Generic[T]`), so the walk knows the method set is not complete. A C#
 * `partial` class says so. {} for other nodes and languages.
 */
function classBases(language: string, node: any): Record<string, unknown> {
  const plain = (n: any) => String(n?.text ?? '').replace(/<[\s\S]*$/, '').trim();
  const named = (n: any, ok: string[], text: (n: any) => string = (x) => x.text) => (n && ok.includes(n.type) ? text(n) : '?');
  let bases: string[] = [];
  const meta: Record<string, unknown> = {};
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    const heritage = node.namedChildren?.find((c: any) => c.type === 'class_heritage');
    const ext = heritage?.namedChildren.find((c: any) => c.type === 'extends_clause') ?? (language === 'javascript' ? heritage : null);
    const value = ext?.childForFieldName?.('value') ?? ext?.namedChildren[0];
    if (ext) bases = [named(value, ['identifier', 'member_expression'])];
  } else if (language === 'java') {
    const type = node.childForFieldName?.('superclass')?.namedChildren[0];
    const interfaces = node.childForFieldName?.('interfaces')?.namedChildren.find((c: any) => c.type === 'type_list')?.namedChildren ?? [];
    const javaType = (t: any) => named(t, ['type_identifier', 'scoped_type_identifier', 'generic_type'], (x) => plain(x).split('.').pop()!);
    bases = [...(type ? [javaType(type)] : []), ...interfaces.map(javaType)];
  } else if (language === 'c-sharp') {
    const list = node.namedChildren?.find((c: any) => c.type === 'base_list');
    bases = (list?.namedChildren ?? []).filter((c: any) => c.type !== 'comment').map((c: any) =>
      named(c, ['identifier', 'qualified_name', 'generic_name'], (x) => plain(x).split('.').pop()!));
    if (node.namedChildren?.some((c: any) => c.type === 'modifier' && c.text === 'partial')) meta['partial'] = true;
  } else if (language === 'python') {
    bases = (node.childForFieldName?.('superclasses')?.namedChildren ?? [])
      .filter((c: any) => c.type !== 'keyword_argument' && c.type !== 'comment')
      .map((c: any) => named(c, ['identifier', 'attribute']))
      .filter((b: string) => b !== 'object');
  }
  bases = bases.map((b) => (/^[A-Za-z_$][\w$.]*$/.test(b) ? b : '?'));
  if (bases.length) meta['bases'] = bases;
  return meta;
}

/**
 * The type a C# extension method extends (`static int Spin(this Acme.App.Widget w)` → Widget;
 * review of M2-12), so a new instance of it reaches the method. {} for any other node.
 */
function extensionOf(language: string, node: any): Record<string, unknown> {
  if (language !== 'c-sharp' || node?.type !== 'method_declaration') return {};
  const first = node.childForFieldName?.('parameters')?.namedChildren.find((c: any) => c.type === 'parameter');
  if (!first?.namedChildren.some((c: any) => c.type === 'modifier' && c.text === 'this') && !/^this\s/.test(first?.text ?? '')) return {};
  const type = String(first.childForFieldName?.('type')?.text ?? '').replace(/<[\s\S]*$/, '').split('.').pop()!.trim();
  return /^[A-Za-z_]\w*$/.test(type) ? { extensionOf: type } : {};
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

/** Adds the names a JS/TS or Python binding pattern declares: `a`, `{ a, b: c }`, `[d, ...e]`, `f, g`. */
function patternNames(n: any, out: Set<string>): Set<string> {
  switch (n?.type) {
    case 'identifier': case 'shorthand_property_identifier_pattern': out.add(n.text); break;
    case 'pair_pattern': patternNames(n.childForFieldName('value'), out); break;
    case 'object_assignment_pattern': case 'assignment_pattern': patternNames(n.childForFieldName('left'), out); break;
    case 'object_pattern': case 'array_pattern': case 'rest_pattern':
    case 'pattern_list': case 'tuple_pattern': case 'list_pattern': case 'list_splat_pattern':
      for (const c of n.namedChildren) patternNames(c, out);
      break;
  }
  return out;
}

/** True when `inner` lies within `outer`. */
function within(outer: any, inner: any): boolean {
  return !!outer && outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * What a call through a local binding of a JS/TS or Python name is: `local` (the binding is the name's
 * and links nothing), `unproven` (a destructured name whose source may be a project symbol: it keeps
 * the by-name link, marked inferred), or null (not bound here).
 */
type LocalBinding = 'local' | 'unproven' | null;

/** Per-parse caches for `boundLocally`: the file's imports (name → specifier) and each declarator's, function body's bindings. */
interface ScopeCache {
  imports?: Map<string, string>;
  declarators: Map<number, { names: Set<string>; source: LocalBinding } | null>;
  hoisted: Map<number, Map<string, LocalBinding>>;
}

const newScopeCache = (): ScopeCache => ({ declarators: new Map(), hoisted: new Map() });

/** The names a JS/TS file's top-level import statements bind, with their module specifiers. */
function importsOf(node: any, cache: ScopeCache): Map<string, string> {
  if (cache.imports) return cache.imports;
  const imports = new Map<string, string>();
  let root = node;
  while (root.parent) root = root.parent;
  for (const s of root.namedChildren) {
    if (s.type !== 'import_statement') continue;
    const spec = s.childForFieldName('source')?.text.slice(1, -1) ?? '';
    const walk = (n: any) => {
      if (n.type === 'identifier') { imports.set(n.text, spec); return; }
      if (n.type === 'import_specifier') {
        const bound = n.childForFieldName('alias') ?? n.childForFieldName('name');
        if (bound) imports.set(bound.text, spec);
        return;
      }
      for (const c of n.namedChildren) walk(c);
    };
    for (const c of s.namedChildren) if (c.type === 'import_clause') walk(c);
  }
  return (cache.imports = imports);
}

const NODE_BUILTINS = new Set(builtinModules);

/**
 * True when a module specifier names a package or a runtime builtin, never a project file: a
 * `node:`/`bun:` style scheme, a Node builtin, a scoped package. `loose` also takes a bare one-segment
 * name (`lodash`, `pinia`), which an import statement or `require` makes certain enough: a tsconfig
 * `baseUrl` path has a folder (`stores/user`), but is not known here and stays unproven.
 */
function isPackageSpecifier(spec: string, loose: boolean): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || NODE_BUILTINS.has(spec) || /^@[\w.-]+\/[\w.-]+/.test(spec)) return true;
  return loose && /^[\w.-]+$/.test(spec) && !spec.startsWith('.');
}

/**
 * Whether what a destructuring reads from provably holds no project symbol (`local`: an object or
 * array literal, a name imported from a package or a call of one, a call given a package specifier
 * such as `load('bun:sqlite')`), is an import (null: the scanner resolves the names a `require`,
 * `import()` or project import binds, M2-20, M2-08-R3), or may be anything (`unproven`: `this.service`, a local variable, a new instance, the
 * result of a function of this project).
 */
function sourceBinding(value: any, cache: ScopeCache, at: any): LocalBinding {
  for (let step = 0; value && step < 20; step++) {
    switch (value.type) {
      case 'object': case 'array': return 'local';
      case 'await_expression': case 'parenthesized_expression': case 'non_null_expression':
      case 'as_expression': case 'satisfies_expression':
        value = value.namedChildren[0];
        continue;
      case 'call_expression': {
        const callee = value.childForFieldName('function');
        const first = value.childForFieldName('arguments')?.namedChildren[0];
        const spec = first?.type === 'string' ? first.text.slice(1, -1) : null;
        // The names a `require` or `import()` binds belong to the scanner: the project module's
        // exports (M2-20), or a package's, kept as external references (M2-08-R3, M5-19).
        if (callee?.type === 'import' || (callee?.type === 'identifier' && callee.text === 'require')) return null;
        if (spec !== null && isPackageSpecifier(spec, false)) return 'local';
        value = callee;
        continue;
      }
      case 'new_expression': value = value.childForFieldName('constructor'); continue;
      case 'member_expression': value = value.childForFieldName('object'); continue;
      case 'identifier': {
        const spec = importsOf(at, cache).get(value.text);
        return spec === undefined ? 'unproven' : isPackageSpecifier(spec, true) ? 'local' : null;
      }
      default: return 'unproven';
    }
  }
  return 'unproven';
}

/** What a `const`/`let`/`var` declaration makes of `name`: a plain variable, a destructured local, or nothing. */
function declarationBinding(declaration: any, name: string, cache: ScopeCache): LocalBinding {
  if (declaration?.type !== 'lexical_declaration' && declaration?.type !== 'variable_declaration') return null;
  for (const d of declaration.namedChildren) {
    if (d.type !== 'variable_declarator') continue;
    const target = d.childForFieldName('name');
    if (target?.type === 'identifier') {
      if (target.text === name) return 'local';
      continue;
    }
    if (target?.type !== 'object_pattern' && target?.type !== 'array_pattern') continue;
    let info = cache.declarators.get(d.id);
    if (info === undefined) {
      info = { names: patternNames(target, new Set()), source: sourceBinding(d.childForFieldName('value'), cache, d) };
      cache.declarators.set(d.id, info);
    }
    if (info && info.source && info.names.has(name)) return info.source;
  }
  return null;
}

/** The `var` names declared anywhere in a function body outside nested functions: they are hoisted to it. */
function hoistedVars(body: any, cache: ScopeCache): Map<string, LocalBinding> {
  let vars = cache.hoisted.get(body.id);
  if (vars) return vars;
  vars = new Map();
  const walk = (n: any) => {
    for (const c of n.namedChildren) {
      if (JS_FUNCTION_NODES.has(c.type) || c.type === 'class_declaration' || c.type === 'class') continue;
      if (c.type === 'variable_declaration') {
        for (const d of c.namedChildren) {
          const target = d.type === 'variable_declarator' ? d.childForFieldName('name') : null;
          if (target?.type === 'identifier') vars!.set(target.text, 'local');
          else if (target) {
            const source = sourceBinding(d.childForFieldName('value'), cache, d);
            if (source) for (const n2 of patternNames(target, new Set())) if (vars!.get(n2) !== 'local') vars!.set(n2, source);
          }
        }
      }
      walk(c);
    }
  };
  walk(body);
  cache.hoisted.set(body.id, vars);
  return vars;
}

/**
 * Whether `name()` at `node` calls a parameter or a local variable of an enclosing JS/TS function or
 * block, or Python function (M0-17-R5): a plain declaration (a `var` hoisted from a nested block
 * too), a for / for-of / for-in variable, a catch parameter, a comprehension variable
 * (M2-25). Such a call never reaches a module symbol of that name, which is now often a function
 * (`const useAppSelector = useSelector`): the guard M0-17-R2 had from skipping constants.
 *
 * A destructured local (`const { f } = load('bun:sqlite')`) is local when its source provably holds no
 * project symbol (`sourceBinding`, M2-26); when it may (`const { find } = this.users`), it is
 * `unproven`, and the call keeps its by-name link marked inferred.
 */
function boundLocally(node: any, name: string, cache: ScopeCache): LocalBinding {
  let curr = node.parent;
  for (; curr && curr.type !== 'program' && curr.type !== 'module'; curr = curr.parent) {
    const params = curr.type === 'arrow_function' && !curr.childForFieldName('parameters')
      ? curr.childForFieldName('parameter') : curr.childForFieldName('parameters');
    if ((JS_FUNCTION_NODES.has(curr.type) || curr.type === 'function_definition' || curr.type === 'lambda') && bindsName(params, name)) return 'local';
    // `for (const step of STEPS) step()`, `catch (cb) { cb() }`: bound in the body, not in the iterable.
    const loopVar = curr.type === 'for_in_statement' || curr.type === 'for_statement' ? curr.childForFieldName('left')
      : curr.type === 'catch_clause' ? curr.childForFieldName('parameter') : null;
    if (loopVar && !within(curr.childForFieldName('right'), node) && patternNames(loopVar, new Set()).has(name)) return 'local';
    // `for (let run = …; ; ) run()`.
    if (curr.type === 'for_statement') {
      const declared = declarationBinding(curr.childForFieldName('initializer'), name, cache);
      if (declared) return declared;
    }
    if (curr.type === 'list_comprehension' || curr.type === 'set_comprehension' || curr.type === 'dictionary_comprehension' || curr.type === 'generator_expression') {
      if (curr.namedChildren.some((c: any) => c.type === 'for_in_clause' && !within(c.childForFieldName('right'), node)
        && patternNames(c.childForFieldName('left'), new Set()).has(name))) return 'local';
    }
    const jsBlock = curr.type === 'statement_block' && curr.parent?.type !== 'internal_module' && curr.parent?.type !== 'module';
    const pyBody = curr.type === 'block' && curr.parent?.type === 'function_definition';
    if (!jsBlock && !pyBody) continue;
    for (const s of curr.namedChildren) {
      const declared = declarationBinding(s, name, cache);
      if (declared) return declared;
      const assignment = s.type === 'expression_statement' ? s.namedChildren[0] : null;
      if (pyBody && assignment?.type === 'assignment' && assignment.childForFieldName('left')?.type === 'identifier' && assignment.childForFieldName('left').text === name) return 'local';
    }
    if (jsBlock && JS_FUNCTION_NODES.has(curr.parent?.type)) {
      const hoisted = hoistedVars(curr, cache).get(name);
      if (hoisted) return hoisted;
    }
  }
  // A module-level destructuring holds no symbol of its own; a plain module-level `const x` does,
  // and the scanner knows it.
  if (curr?.type !== 'program') return null;
  for (const s of curr.namedChildren) {
    if (s.type !== 'lexical_declaration' && s.type !== 'variable_declaration') continue;
    if (s.namedChildren.some((d: any) => d.type === 'variable_declarator' && d.childForFieldName('name')?.type === 'identifier' && d.childForFieldName('name').text === name)) continue;
    const declared = declarationBinding(s, name, cache);
    if (declared) return declared;
  }
  return null;
}

/**
 * Go `struct { log.Logger }`: the import path of the package qualifying an embedded type (or named
 * by `qualifier`: `domain.NewOrder()`, M5-25-R1), by
 * import alias or package name (the last path element without a `.vN`, `vN` or `go-` decoration).
 * When no import matches by name, the unaliased imports are returned as candidates: a package's
 * name need not be its last path element (`api/v1` declaring `package v1`, `internal/db` declaring
 * `package database`); the scanner keeps the one project package that declares the type
 * (review 2026-11-02). Null when there is no candidate (M0-17-R5).
 */
function goImportPath(node: any, qualifier = node.childForFieldName('package')?.text): string | string[] | null {
  let root = node;
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

/** Names a Go parameter list, var or const declaration, short declaration, range or for clause declares. */
function goDeclaredNames(n: any): string[] {
  switch (n?.type) {
    case 'parameter_declaration': case 'variadic_parameter_declaration': case 'var_spec': case 'const_spec': case 'type_parameter_declaration':
      return n.childrenForFieldName('name').map((c: any) => c.text);
    case 'parameter_list': case 'var_declaration': case 'const_declaration': case 'var_spec_list':
      return n.namedChildren.flatMap(goDeclaredNames);
    case 'short_var_declaration': case 'range_clause':
      return (n.childForFieldName('left')?.namedChildren ?? []).filter((c: any) => c.type === 'identifier').map((c: any) => c.text);
    case 'for_clause': return goDeclaredNames(n.childForFieldName('initializer'));
    default: return [];
  }
}

/**
 * True when `name` at `node` is a Go local: a parameter, receiver or named result of an enclosing
 * function, method or function literal, or a variable declared before it in an enclosing block or
 * statement header (`x := …`, `var x`, `for _, x := range`, `if x := …;`, `switch x := v.(type)`).
 * `user := user.New()` still calls the package: the variable's scope starts after its declaration
 * (M5-25-R1, review).
 */
function goBoundLocally(node: any, name: string): boolean {
  for (let curr = node.parent; curr && curr.type !== 'source_file'; curr = curr.parent) {
    if (curr.type === 'function_declaration' || curr.type === 'method_declaration' || curr.type === 'func_literal') {
      if (['receiver', 'parameters', 'result'].some((f) => goDeclaredNames(curr.childForFieldName(f)).includes(name))) return true;
      if (curr.type !== 'func_literal') return false;
    }
    if (curr.type === 'type_switch_statement' && (curr.childForFieldName('alias')?.namedChildren ?? []).some((c: any) => c.text === name)) return true;
    for (const s of curr.namedChildren) {
      if (s.endIndex <= node.startIndex && goDeclaredNames(s).includes(name)) return true;
    }
  }
  return false;
}

/** True when `name` at `node` is a type parameter of the enclosing generic function, type or method receiver (M5-25-R1, review). */
function goTypeParameter(node: any, name: string): boolean {
  for (let curr = node.parent; curr; curr = curr.parent) {
    const list = curr.type === 'function_declaration' || curr.type === 'type_spec' ? curr.childForFieldName('type_parameters') : null;
    if (list?.namedChildren.some((d: any) => goDeclaredNames(d).includes(name))) return true;
    if (curr.type === 'method_declaration') {
      // `func (p *Pair[K, V]) M()`: the receiver type's arguments name the type parameters, through
      // parentheses too, `(*Pair[K, V])` (M5-25-R4).
      let type = curr.childForFieldName('receiver')?.namedChildren[0]?.childForFieldName('type');
      while (type?.type === 'pointer_type' || type?.type === 'parenthesized_type') type = type.namedChildren[0];
      const args = type?.type === 'generic_type' ? type.childForFieldName('type_arguments') : null;
      return !!args?.descendantsOfType('type_identifier').some((t: any) => t.text === name);
    }
  }
  return false;
}

const GO_PREDECLARED_TYPES = new Set(['any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);

/**
 * The type a Go composite literal instantiates, from its type node: `Box[int]`, `[]*domain.Item`,
 * `[N]Item`, `map[K][]domain.Item` and `map[K]*Box[int]` name their (map: value) element type
 * (M5-25-R1). The name node of a type (inside its `qualified_type` when qualified), or null for a
 * predeclared type, a type parameter or a type literal (`[]struct{…}`, `[]func()`).
 */
function goLiteralElement(type: any): any {
  for (let n = type; n; ) {
    switch (n.type) {
      case 'generic_type': n = n.childForFieldName('type'); break;
      case 'slice_type': case 'array_type': case 'implicit_length_array_type': n = n.childForFieldName('element'); break;
      case 'map_type': n = n.childForFieldName('value'); break;
      case 'pointer_type': case 'parenthesized_type': n = n.namedChildren[0]; break;
      case 'qualified_type': return n.childForFieldName('name');
      case 'type_identifier':
        if (n.parent?.type === 'qualified_type') return n;
        return GO_PREDECLARED_TYPES.has(n.text) || goTypeParameter(n, n.text) ? null : n;
      default: return null;
    }
  }
  return null;
}

/** A Go named type: `goType`, with the import path of its package when qualified (`*legacy.Conn`, `Pair[K, V]`). */
interface GoNamedType { goType?: string; goPackage?: string | string[] | null }

/** The named type a Go type node denotes through pointers and generic arguments; {} for a predeclared type, a type parameter or a type literal. */
function goNamedType(type: any): GoNamedType {
  for (let n = type; n; ) {
    switch (n.type) {
      case 'pointer_type': case 'parenthesized_type': n = n.namedChildren[0]; break;
      case 'generic_type': n = n.childForFieldName('type'); break;
      case 'qualified_type': return { goType: n.childForFieldName('name')?.text, goPackage: goImportPath(n) };
      case 'type_identifier': return GO_PREDECLARED_TYPES.has(n.text) || goTypeParameter(n, n.text) ? {} : { goType: n.text };
      default: return {};
    }
  }
  return {};
}

/** The named type of a Go composite literal, through `&` and parentheses (`&legacy.Pair{}`, `Box[int]{}`). */
function goLiteralType(expr: any): GoNamedType {
  let n = expr;
  while (n?.type === 'parenthesized_expression' || (n?.type === 'unary_expression' && n.childForFieldName('operator')?.text === '&')) {
    n = n.type === 'parenthesized_expression' ? n.namedChild(0) : n.childForFieldName('operand');
  }
  return n?.type === 'composite_literal' ? goNamedType(n.childForFieldName('type')) : {};
}

/** The type `name` gets from a declaration that declares it: `var x T`, `var x = T{}`, `x := &pkg.T{}`. */
function goDeclarationType(decl: any, name: string): GoNamedType {
  switch (decl?.type) {
    case 'parameter_declaration': case 'variadic_parameter_declaration':
      return decl.type === 'parameter_declaration' ? goNamedType(decl.childForFieldName('type')) : {};
    case 'var_declaration': case 'var_spec_list': {
      const spec = decl.namedChildren.find((c: any) => goDeclaredNames(c).includes(name));
      return spec ? goDeclarationType(spec, name) : {};
    }
    case 'var_spec': {
      if (decl.childForFieldName('type')) return goNamedType(decl.childForFieldName('type'));
      const i = goDeclaredNames(decl).indexOf(name);
      return goLiteralType(decl.childForFieldName('value')?.namedChildren[i]);
    }
    case 'short_var_declaration': {
      const i = goDeclaredNames(decl).indexOf(name);
      return goLiteralType(decl.childForFieldName('right')?.namedChildren[i]);
    }
    default: return {};
  }
}

/**
 * The type the Go variable or parameter `name` at `node` is declared with (M5-25-R2): the nearest
 * declaration as goBoundLocally finds it (a receiver, parameter or result, or a variable declared
 * before it in an enclosing block), else a package-level `var` of the file. {} when the type is
 * not written: a call's result, a range variable, a type switch alias.
 */
function goVariableType(node: any, name: string): GoNamedType {
  let curr = node.parent;
  for (; curr && curr.type !== 'source_file'; curr = curr.parent) {
    if (curr.type === 'function_declaration' || curr.type === 'method_declaration' || curr.type === 'func_literal') {
      for (const field of ['receiver', 'parameters', 'result']) {
        const decl = (curr.childForFieldName(field)?.namedChildren ?? []).find((d: any) => goDeclaredNames(d).includes(name));
        if (decl) return goDeclarationType(decl, name);
      }
      if (curr.type !== 'func_literal') {
        while (curr.parent) curr = curr.parent;
        break;
      }
    }
    if (curr.type === 'type_switch_statement' && (curr.childForFieldName('alias')?.namedChildren ?? []).some((c: any) => c.text === name)) return {};
    // The last declaration before the use, in this block or statement header.
    let decl: any = null;
    for (const s of curr.namedChildren) if (s.endIndex <= node.startIndex && goDeclaredNames(s).includes(name)) decl = s;
    if (decl) return goDeclarationType(decl, name);
  }
  // Package level: declared anywhere in the file.
  const decl = (curr?.namedChildren ?? []).find((s: any) => s.type === 'var_declaration' && goDeclaredNames(s).includes(name));
  return decl ? goDeclarationType(decl, name) : {};
}

/**
 * Go `pkg.F()` and `pkg.T{}.M()`: the package (and, on a literal, the type) a selector call reaches
 * (M5-25-R1). An identifier qualifier counts only when an import of the file is named by it and no
 * local (parameter, variable) shadows it. Any other selector call is a method call on a value
 * (`goReceiver`, M5-25-R2), with the type the value is declared with when the code writes it
 * (`var x legacy.Pair`, `c *legacy.Conn`, `p Pair[K, V]`, `x := legacy.Pair{}`, `Box[int]{}`);
 * `goMaybePackage` marks a bare identifier that is no local, which may still name a package.
 */
function goSelectorCall(selector: any): Record<string, unknown> {
  const operand = selector.childForFieldName('operand');
  if (operand?.type === 'identifier') {
    const path = goImportPath(selector, operand.text);
    const local = goBoundLocally(operand, operand.text);
    if (typeof path === 'string' && !local) return { goPackage: path };
    const declared = goVariableType(operand, operand.text);
    return { goReceiver: operand.text, ...declared, ...(!local && !declared.goType ? { goMaybePackage: true } : {}) };
  }
  // `pkg.T{}`, `(&pkg.T{}).M()`, `pkg.Pair[K, V]{}`, and a local type's literal `Box[int]{}`
  const literal = goLiteralType(operand);
  return literal.goType ? { goReceiver: `<${operand.type}>`, ...literal } : { goReceiver: `<${operand?.type}>` };
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
    let ambient: ParseResult['ambient'];
    let parsed: Awaited<ReturnType<typeof parseWithQueries>> | undefined;

    try {
      parsed = await parseWithQueries(
        source, this.language, this.symbolsQuery!, this.referencesQuery!,
        // JS/TS, Python and Go files: the ambient accesses (environment, globals), M5-24-R1.
        (root) => { ambient = ambientAccesses(this.languageName, root, source); },
      );
      const { symbols: symCaptures, references: refCaptures, nameByNodeId, scopeByNodeId } = parsed;

      let currentScope: string | null = null;
      const scopeCache = newScopeCache();
      const seenNodeIds = new Set<number>();
      // Each stored symbol by its node, labelled as the scanner names a source symbol (M5-03-R2).
      const symbolByNodeId = new Map<number, { kind: SymbolKind; label: string; oneLine: boolean }>();
      /**
       * The function or method a reference sits in when that function is on one line: there the
       * scanner's line ranges cannot tell it from a same-line namespace or type
       * (`namespace a::b { void use() { f(); } }`), so the syntax tree decides. Null otherwise, and
       * in a Vue SFC, whose own rule gives references their owner (vue-template.ts, rule 2).
       */
      const oneLineSource = (node: any): string | null => {
        if (filePath.endsWith('.vue')) return null;
        for (let p = node.parent; p; p = p.parent) {
          const sym = symbolByNodeId.get(p.id);
          if (sym) return sym.oneLine && (sym.kind === 'function' || sym.kind === 'method') ? sym.label : null;
        }
        return null;
      };

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
                  curr.type === 'object_definition' || // Scala `object Util { def x … }` (M5-03-R1)
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

            symbolByNodeId.set(capture.node.id, { kind, label: resolvedScope ? `${resolvedScope}::${name}` : name, oneLine: startLine === endLine });
            symbols.push({
              name,
              kind,
              scope: resolvedScope,
              signature,
              startLine,
              endLine,
              // The namespace of each C# and Scala declaration, for its qualified name (M5-03-R2);
              // decorators and doc tags (M5-10).
              metadata: {
                ...(kind !== 'namespace' && (this.languageName === 'c-sharp' || this.languageName === 'scala')
                  ? { namespace: declaredNamespace(capture.node) } : this.symbolMetadata(capture.node)),
                ...symbolAnnotations(this.languageName, capture.node),
                ...(kind === 'class' ? classBases(this.languageName, capture.node.type === 'export_statement' ? capture.node.namedChildren.find((c: any) => c.type === 'class_declaration' || c.type === 'class') ?? capture.node : capture.node) : {}),
                ...(kind === 'method' ? extensionOf(this.languageName, capture.node) : {}),
              },
            });
          }
        }
      }

      // Lua scopes, for the receivers of method calls, computed on the first one (M2-10).
      let luaScopes: LuaScopes | undefined;
      const luaScopesOf = () => (luaScopes ??= new LuaScopes());

      for (const [captureName, captures] of refCaptures) {
        if (captureName.startsWith('ref.target_')) {
          const refType = captureName.replace('ref.target_', '');
          for (const rawCapture of captures) {
            // Go `[]domain.Item{}`, `map[K]*Box[int]{}`: the element type the literal names; none for
            // a predeclared type or a type parameter (M5-25-R1).
            const goElement = this.languageName === 'go' && refType === 'instantiation' ? goLiteralElement(rawCapture.node) : undefined;
            if (goElement === null) continue;
            const capture = goElement ? { node: goElement } : rawCapture;
            // Scala `import a.b.{C, D => E}` is one node naming several targets (M0-17-R1).
            const targetTexts = capture.node.type === 'import_declaration' && refType === 'import'
              ? scalaImportTargets(capture.node)
              : [refType === 'import' || refType === 'require' ? markImportTarget(capture.node, capture.node.text) : capture.node.text];
            for (const targetText of targetTexts) {
            if (!targetText || typeof targetText !== 'string') continue;
            const csharpBase = csharpBaseType(capture.node);
            // A C# generic base `List<int>` names the type List (M0-17-R2).
            // Lua `self:log()` in `function Account:m()` targets Account:log (M2-10).
            const luaTarget = this.languageName === 'lua' && refType === 'call' ? luaCallTarget(capture.node, luaScopesOf) : null;
            const targetName = luaTarget?.targetName ?? (csharpBase ? targetText.replace(/<[\s\S]*$/, '').trim() : this.cleanTarget(targetText, refType));
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
              && CALL_NODES.has(capture.node.parent?.type ?? '')) {
              const bound = boundLocally(capture.node, targetName, scopeCache);
              if (bound === 'local') continue;
              // A destructured name whose source may be a project symbol (`const { find } = this.users`).
              if (bound === 'unproven') verifiability = 'inferred';
            }

            // Go `struct { log.Logger }`, `domain.Order{}`, `domain.NewOrder()` and `domain.Order{}.Run()`:
            // the declaration lives in the imported package, which the scanner resolves; a library
            // package (null when no import matches) links nothing (M0-17-R5, M5-25, M5-25-R1).
            const goParent = this.languageName === 'go' ? capture.node.parent : null;
            const goPackage = (referenceType === 'extends' || referenceType === 'instantiation') && goParent?.type === 'qualified_type'
              ? { goPackage: goImportPath(goParent) }
              : referenceType === 'call' && goParent?.type === 'selector_expression' ? goSelectorCall(goParent) : null;
            // `new Order().total()`: the class whose method the scanner links (M2-12).
            const newClass = referenceType === 'call' ? newReceiverClass(capture.node, this.languageName) : undefined;
            // A new instance of a class the syntax does not name: no class to link, and never a
            // same-named method by name (M2-12 review).
            if (newClass === null) continue;
            // `require('./m').f()`: the module whose export f the scanner links (M2-20).
            const required = referenceType === 'call' && receiver?.type === 'call_expression' ? requireSpecifier(receiver) : null;
            // A top-level `require('./m')` is the file's dependency, not the `const x = …` it initialises (M2-20).
            const topRequire = referenceType === 'import' && requireSpecifier(capture.node.parent?.parent) !== null && outsideFunctions(capture.node);

            references.push({
              sourceSymbol: topRequire ? null : oneLineSource(capture.node),
              targetName,
              referenceType,
              startLine,
              verifiability,
              // The receiver of a member call (`obj`, `this`, `super`, `a.b`), for the scanner to tell a
              // library object and never take the call for a global function (M0-17-R4).
              ...(referenceType === 'call' && (receiver || newClass) ? { metadata: {
                ...(receiver ? { receiver: receiver.type === 'identifier' ? receiver.text : `<${receiver.type}>` } : {}),
                ...(newClass ? { newClass } : {}),
                ...(required !== null ? { required } : {}),
              } } : {}),
              ...(topRequire ? { metadata: { fileLevel: true } } : {}),
              // The import path of a package-qualified Go type or call (M0-17-R5, M5-25, M5-25-R1).
              ...(goPackage ? { metadata: goPackage } : {}),
              // Where the table of a Lua `T:m()` call lives, for the scanner (M2-10).
              ...(luaTarget && 'luaTable' in luaTarget ? { metadata: { luaTable: luaTarget.luaTable } } : {}),
            });
            }
          }
        }
      }
    } catch (e: any) {
      errors.push({ message: e.message, line: 0 });
    } finally {
      // The nodes are read; free the tree (M2-08-R9).
      parsed?.dispose();
    }

    return { symbols, references, errors, ...(ambient ? { ambient } : {}) };
  }

  protected isContainerKind(kind: SymbolKind): boolean {
    return kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum' || kind === 'struct' || kind === 'module';
  }

  protected isMemberKind(kind: SymbolKind): boolean {
    return kind === 'method' || kind === 'property' || kind === 'constant' || kind === 'field';
  }



  /** A symbol's parser metadata, from its kind node (JS/TS member assignments: M2-09). */
  protected symbolMetadata(_node: any): Record<string, unknown> {
    return {};
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
