// Ambient access (M5-24-R1; docs/research/deptrac/02-abstract-feature-model.md AR-04, `ambient`): a
// file reads process-global state it needs no import for. One element per concept name:
//   env     JS/TS `process.env`; PHP `$_ENV`, `getenv()`; Python `os.environ`, `os.getenv`; Go
//           `os.Getenv`, `os.LookupEnv`, `os.Environ`
//   argv    Python `sys.argv`; Go `os.Args`
//   window, document, globalThis, localStorage     JS/TS browser globals
//   $_GET $_POST $_SERVER $_SESSION $_COOKIE $_FILES $_REQUEST $GLOBALS     PHP superglobals
// The walks read the syntax tree, so a comment or a string never counts, and a name the file binds
// itself (a parameter, a local, a catch variable, an import, a function or a class; a Go local;
// a Python `os` that is no import of `os`) is not the global. JS `process` imported from `process`
// or `node:process` is the global module, so it counts. PHP: a superglobal interpolated in a double-quoted
// string, a heredoc or a backtick string is read, so it counts; one in a single-quoted string, nowdoc or comment does not.
import type { AmbientAccess } from '../types.js';

type Node = any;

const BROWSER_GLOBALS = new Set(['window', 'document', 'globalThis', 'localStorage']);
const PHP_SUPERGLOBALS = new Set(['$_GET', '$_POST', '$_SERVER', '$_ENV', '$_SESSION', '$_COOKIE', '$_FILES', '$_REQUEST', '$GLOBALS']);
const GO_ENV = new Set(['Getenv', 'LookupEnv', 'Environ', 'Setenv', 'Unsetenv', 'ExpandEnv', 'Clearenv']);

/** The ambient accesses of a parsed file, by line; undefined for a language without any. */
export function ambientAccesses(language: string, root: Node, source: string): AmbientAccess[] | undefined {
  let found: AmbientAccess[];
  switch (language) {
    case 'javascript': case 'typescript': case 'tsx':
      if (!/\b(?:window|document|globalThis|localStorage|process)\b/.test(source)) return undefined;
      found = jsAmbient(root);
      break;
    case 'php':
      if (!/\$_(?:GET|POST|SERVER|ENV|SESSION|COOKIE|FILES|REQUEST)\b|\$GLOBALS\b|getenv/i.test(source)) return undefined;
      found = phpAmbient(root);
      break;
    case 'python':
      if (!/\b(?:os|sys|environ|getenv|argv)\b/.test(source)) return undefined;
      found = pythonAmbient(root);
      break;
    case 'go':
      if (!/\bos\b/.test(source)) return undefined;
      found = goAmbient(root);
      break;
    default:
      return undefined;
  }
  return found.length ? found.sort((a, b) => a.line - b.line) : undefined;
}

const lineOf = (n: Node) => n.startPosition.row + 1;

// ─── JS / TS ────────────────────────────────────────────────────────────────────────────────

const JS_FUNCTIONS = new Set([
  'function_declaration', 'function_expression', 'function', 'arrow_function', 'method_definition',
  'generator_function_declaration', 'generator_function',
  // TS signatures without a body (overloads, abstract methods, call and construct signatures): their
  // parameter names are declarations too.
  'function_signature', 'method_signature', 'abstract_method_signature', 'call_signature', 'construct_signature',
  'function_type', 'constructor_type',
]);
/** Ancestors in which an identifier names a type or a declaration of the global, not a use of it. */
const JS_TYPE_ONLY = new Set(['type_query', 'ambient_declaration', 'interface_declaration', 'type_alias_declaration']);
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** The names a binding pattern declares: `a`, `{ a, b: c }`, `[d, ...e]`, a parameter list. */
function jsPatternNames(n: Node, out: Set<string>): Set<string> {
  switch (n?.type) {
    case 'identifier': case 'shorthand_property_identifier_pattern': out.add(n.text); break;
    case 'pair_pattern': jsPatternNames(n.childForFieldName('value'), out); break;
    case 'assignment_pattern': case 'object_assignment_pattern': jsPatternNames(n.childForFieldName('left'), out); break;
    case 'required_parameter': case 'optional_parameter': jsPatternNames(n.childForFieldName('pattern'), out); break;
    case 'formal_parameters': case 'object_pattern': case 'array_pattern': case 'rest_pattern':
      for (const c of n.namedChildren) if (c.type !== 'type_annotation') jsPatternNames(c, out);
      break;
  }
  return out;
}

/** Whether an object pattern destructures the property `key`: `{ env }`, `{ env: e }`, `{ env = {} }`. */
function patternHasKey(pattern: Node, key: string): boolean {
  if (pattern?.type !== 'object_pattern') return false;
  return pattern.namedChildren.some((c: Node) =>
    ((c.type === 'shorthand_property_identifier_pattern' || c.type === 'object_assignment_pattern') && (c.childForFieldName('left') ?? c).text === key)
    || (c.type === 'pair_pattern' && c.childForFieldName('key')?.text === key));
}

/** Whether a declarator's value is `require('process')` or `require('node:process')`. */
function requiresProcess(declarator: Node): boolean {
  let value = declarator.childForFieldName('value');
  if (value?.type === 'await_expression') value = value.namedChildren[0];
  if (value?.type !== 'call_expression' || value.childForFieldName('function')?.text !== 'require') return false;
  const spec = value.childForFieldName('arguments')?.namedChildren[0];
  return spec?.type === 'string' && PROCESS_MODULES.has(spec.text.slice(1, -1));
}

/** The names a `let`/`const`/`var` declaration binds; the global `process` module's binding is left out. */
function declaredNames(declaration: Node, name: string, out: Set<string>): void {
  for (const d of declaration.namedChildren) {
    if (d.type !== 'variable_declarator') continue;
    const target = d.childForFieldName('name');
    if (name === 'process' && target?.type === 'identifier' && target.text === 'process' && requiresProcess(d)) continue;
    jsPatternNames(target, out);
  }
}

/** The names an import statement binds, except `process` bound to the `process` module itself. */
function importedNames(statement: Node, name: string, out: Set<string>): void {
  const source = statement.childForFieldName('source')?.text.slice(1, -1) ?? '';
  const global = name === 'process' && PROCESS_MODULES.has(source);
  for (const clause of statement.namedChildren) {
    if (clause.type !== 'import_clause') continue;
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier' && !global) out.add(c.text);
      else if (c.type === 'namespace_import' && !global) for (const i of c.namedChildren) out.add(i.text);
      else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          const bound = s.childForFieldName('alias') ?? s.childForFieldName('name');
          if (bound) out.add(bound.text);
        }
      }
    }
  }
}

/** What a statement list declares directly in its own scope: lexical declarations, functions, classes, imports. */
function blockNames(block: Node, name: string): Set<string> {
  const out = new Set<string>();
  for (let s of block.namedChildren) {
    if (s.type === 'export_statement') s = s.childForFieldName('declaration') ?? s;
    switch (s.type) {
      case 'lexical_declaration': case 'variable_declaration': declaredNames(s, name, out); break;
      case 'function_declaration': case 'generator_function_declaration': case 'class_declaration': case 'abstract_class_declaration':
      case 'enum_declaration': case 'internal_module':
        { const id = s.childForFieldName('name'); if (id) out.add(id.text); }
        break;
      case 'import_statement': importedNames(s, name, out); break;
      case 'import_alias': { const id = s.namedChildren[0]; if (id) out.add(id.text); } break;
    }
  }
  return out;
}

/** The `var` names declared anywhere in a function body or program outside nested functions: hoisted to it. */
function hoistedNames(scope: Node, name: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node) => {
    for (const c of n.namedChildren) {
      if (JS_FUNCTIONS.has(c.type) || c.type === 'class_declaration' || c.type === 'class' || c.type === 'class_body') continue;
      if (c.type === 'variable_declaration') declaredNames(c, name, out);
      walk(c);
    }
  };
  walk(scope);
  return out;
}

function jsAmbient(root: Node): AmbientAccess[] {
  const out: AmbientAccess[] = [];
  // A scope's declarations, per node and tested name (the process module's own binding differs).
  const cache = new Map<string, Set<string>>();
  const cached = (kind: string, scope: Node, name: string, compute: () => Set<string>) => {
    const key = `${kind}:${scope.id}:${name === 'process' ? 'p' : ''}`;
    let names = cache.get(key);
    if (!names) cache.set(key, (names = compute()));
    return names;
  };

  /** Whether `name` at `node` is bound by the file or an enclosing scope, so it is not the global. */
  const bound = (node: Node, name: string): boolean => {
    for (let child = node, cur = node.parent; cur; child = cur, cur = cur.parent) {
      const type = cur.type as string;
      if (JS_FUNCTIONS.has(type)) {
        const params = cur.childForFieldName('parameters') ?? cur.childForFieldName('parameter');
        if (params && jsPatternNames(params, new Set()).has(name)) return true;
        if ((type === 'function_expression' || type === 'function' || type === 'generator_function') && cur.childForFieldName('name')?.text === name) return true;
        const body = cur.childForFieldName('body');
        if (body?.type === 'statement_block' && cached('hoist', body, name, () => hoistedNames(body, name)).has(name)) return true;
      } else if (type === 'program') {
        if (cached('block', cur, name, () => blockNames(cur, name)).has(name) || cached('hoist', cur, name, () => hoistedNames(cur, name)).has(name)) return true;
      } else if (type === 'statement_block' || type === 'class_static_block' || type === 'switch_case' || type === 'switch_default') {
        if (cached('block', cur, name, () => blockNames(cur, name)).has(name)) return true;
      } else if (type === 'for_statement') {
        const init = cur.childForFieldName('initializer');
        if (init && child.id !== init.id && (init.type === 'lexical_declaration' || init.type === 'variable_declaration')) {
          const names = new Set<string>();
          declaredNames(init, name, names);
          if (names.has(name)) return true;
        }
      } else if (type === 'for_in_statement') {
        const right = cur.childForFieldName('right');
        if (cur.childForFieldName('kind') && child.id !== right?.id && jsPatternNames(cur.childForFieldName('left'), new Set()).has(name)) return true;
      } else if (type === 'catch_clause') {
        if (child.id !== cur.childForFieldName('parameter')?.id && jsPatternNames(cur.childForFieldName('parameter'), new Set()).has(name)) return true;
      }
    }
    return false;
  };

  /** An identifier that names an import, an export or a catch parameter is no use of the global. */
  const namesBinding = (node: Node) => {
    const p = node.parent;
    return p?.type === 'import_specifier' || p?.type === 'import_clause' || p?.type === 'namespace_import' || p?.type === 'export_specifier'
      || p?.type === 'namespace_export'
      || (p?.type === 'catch_clause' && p.childForFieldName('parameter')?.id === node.id);
  };

  const typeOnly = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) if (JS_TYPE_ONLY.has(p.type)) return true;
    return false;
  };

  // `import { env } from 'node:process'`: the environment, read where the import names it.
  for (const statement of root.descendantsOfType('import_statement')) {
    const source = statement.childForFieldName('source')?.text.slice(1, -1) ?? '';
    if (!PROCESS_MODULES.has(source)) continue;
    for (const specifier of statement.descendantsOfType('import_specifier')) {
      if (specifier.childForFieldName('name')?.text === 'env') out.push({ line: lineOf(specifier), name: 'env', text: 'process.env' });
    }
  }

  for (const node of root.descendantsOfType(['identifier', 'shorthand_property_identifier'])) {
    const text = node.text as string;
    let name: string | null = null;
    let access = text;
    if (BROWSER_GLOBALS.has(text)) {
      name = text;
    } else if (text === 'process') {
      const member = node.parent;
      if (member?.type === 'member_expression' && member.childForFieldName('object')?.id === node.id && member.childForFieldName('property')?.text === 'env') {
        name = 'env';
        access = 'process.env';
      } else if (member?.type === 'subscript_expression' && member.childForFieldName('object')?.id === node.id && /^(['"`])env\1$/.test(member.childForFieldName('index')?.text ?? '')) {
        // process["env"]
        name = 'env';
        access = 'process.env';
      } else if (member?.type === 'variable_declarator' && member.childForFieldName('value')?.id === node.id && patternHasKey(member.childForFieldName('name'), 'env')) {
        // const { env } = process
        name = 'env';
        access = 'process.env';
      }
    }
    if (!name || namesBinding(node) || typeOnly(node) || bound(node, text)) continue;
    out.push({ line: lineOf(node), name, text: access });
  }
  return out;
}

// ─── PHP ────────────────────────────────────────────────────────────────────────────────────

/** Where PHP does not read a variable: single-quoted strings, nowdocs and comments (no `variable_name` is parsed in them). */
const PHP_INERT = new Set(['string', 'string_content', 'nowdoc', 'nowdoc_body', 'comment']);

/** The namespace in force at a node: its braced block, else the last `namespace x;` statement before it. */
function phpNamespaceAt(root: Node, node: Node): string {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'namespace_definition' && p.childForFieldName('body')) return p.childForFieldName('name')?.text ?? '';
  }
  let namespace = '';
  for (const s of root.namedChildren) {
    if (s.startIndex > node.startIndex) break;
    if (s.type === 'namespace_definition' && !s.childForFieldName('body')) namespace = s.childForFieldName('name')?.text ?? '';
  }
  return namespace;
}

function phpAmbient(root: Node): AmbientAccess[] {
  const out: AmbientAccess[] = [];
  // PHP reads a superglobal in a double-quoted string, a heredoc and a backtick string too
  // (`"id=$_GET[id]"`, `"{$_SERVER['HOST']}"`); only the inert text above is skipped.
  for (const node of root.descendantsOfType('variable_name')) {
    const text = node.text as string;
    if (!PHP_SUPERGLOBALS.has(text)) continue;
    let inert = false;
    for (let p = node.parent; p; p = p.parent) if (PHP_INERT.has(p.type)) { inert = true; break; }
    if (!inert) out.push({ line: lineOf(node), name: text === '$_ENV' ? 'env' : text, text });
  }
  // `getenv()` or `\getenv()`: the global function (a method of the same name is another node type).
  // An unqualified call falls back from the namespace, so it records the namespace for the scanner to
  // check against the workspace's declarations; a `use function` of another getenv hides the global.
  const importsGetenv = root.descendantsOfType('namespace_use_declaration').some((d: Node) => /^use\s+function\b/i.test(d.text) && /\bgetenv\b/i.test(d.text));
  for (const call of root.descendantsOfType('function_call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || !/^\\?getenv$/i.test(fn.text)) continue;
    if (fn.text.startsWith('\\')) { out.push({ line: lineOf(call), name: 'env', text: 'getenv' }); continue; }
    if (importsGetenv) continue;
    const namespace = phpNamespaceAt(root, call);
    out.push({ line: lineOf(call), name: 'env', text: 'getenv', ...(namespace ? { phpNamespace: namespace } : {}) });
  }
  return out;
}

// ─── Python ─────────────────────────────────────────────────────────────────────────────────

/** The names a Python assignment target, `for` target or parameter binds. */
function pyTargetNames(n: Node, out: Set<string>): void {
  switch (n?.type) {
    case 'identifier': out.add(n.text); break;
    case 'pattern_list': case 'tuple_pattern': case 'list_pattern': case 'list_splat_pattern': case 'typed_parameter':
    case 'parameters': case 'lambda_parameters': case 'dictionary_splat_pattern': case 'as_pattern_target':
      for (const c of n.namedChildren) pyTargetNames(c, out);
      break;
    case 'default_parameter': case 'typed_default_parameter': pyTargetNames(n.childForFieldName('name'), out); break;
  }
}

const PY_SCOPES = new Set(['function_definition', 'class_definition', 'lambda']);
const PY_COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/**
 * What a Python scope binds, by name: an import's target (`os`, `os.environ`, `sys`) or null for any
 * other binding. A name bound twice differently is null. Nested functions and classes bind their
 * own name here and are not entered.
 */
function pyBindings(scope: Node): Map<string, string | null> {
  const bindings = new Map<string, string | null>();
  const bind = (name: string, target: string | null) => {
    if (bindings.has(name) && bindings.get(name) !== target) bindings.set(name, null);
    else bindings.set(name, target);
  };
  const others = (names: Set<string>) => { for (const n of names) bind(n, null); };
  if (scope.type === 'function_definition' || scope.type === 'lambda') others((() => { const s = new Set<string>(); pyTargetNames(scope.childForFieldName('parameters'), s); return s; })());
  const walk = (n: Node) => {
    for (const c of n.namedChildren) {
      switch (c.type) {
        case 'import_statement':
          for (const i of c.childrenForFieldName('name')) {
            if (i.type === 'aliased_import') bind(i.childForFieldName('alias')?.text ?? '', i.childForFieldName('name')?.text ?? null);
            else bind((i.text as string).split('.')[0]!, (i.text as string).split('.')[0]!);
          }
          continue;
        case 'import_from_statement': {
          const module = c.childForFieldName('module_name');
          for (const i of c.childrenForFieldName('name')) {
            const imported = i.type === 'aliased_import' ? i.childForFieldName('name')?.text : i.text;
            const local = i.type === 'aliased_import' ? i.childForFieldName('alias')?.text : i.text;
            if (local) bind(local, module?.type === 'dotted_name' && imported ? `${module.text}.${imported}` : null);
          }
          continue;
        }
        case 'function_definition': case 'class_definition': {
          const id = c.childForFieldName('name');
          if (id) bind(id.text, null);
          continue;
        }
        case 'lambda': continue;
        case 'assignment': case 'augmented_assignment': {
          // `try: import os` / `except ImportError: os = None`: the idiom binds nothing new.
          if (c.childForFieldName('right')?.type === 'none') break;
          const s = new Set<string>(); pyTargetNames(c.childForFieldName('left'), s); others(s);
          break;
        }
        case 'for_statement': { const s = new Set<string>(); pyTargetNames(c.childForFieldName('left'), s); others(s); break; }
        case 'named_expression': { const s = new Set<string>(); pyTargetNames(c.childForFieldName('name'), s); others(s); break; }
        case 'as_pattern': { const alias = c.childForFieldName('alias'); if (alias) bind(alias.text, null); break; }
        case 'with_item': case 'except_clause': break;
      }
      walk(c);
    }
  };
  walk(scope.type === 'lambda' ? scope : (scope.childForFieldName('body') ?? scope));
  return bindings;
}

function pythonAmbient(root: Node): AmbientAccess[] {
  const out: AmbientAccess[] = [];
  const cache = new Map<number, Map<string, string | null>>();
  const bindingsOf = (scope: Node) => {
    let b = cache.get(scope.id);
    if (!b) cache.set(scope.id, (b = pyBindings(scope)));
    return b;
  };
  /** What `name` at `node` is bound to: an import target, or null when unbound or bound otherwise. */
  const resolve = (node: Node, name: string): string | null => {
    let crossedFunction = false;
    for (let cur = node.parent; cur; cur = cur.parent) {
      const type = cur.type as string;
      if (PY_COMPREHENSIONS.has(type)) {
        // `[os for os in xs]`: the loop variable is the comprehension's, except in the iterable.
        for (const clause of cur.namedChildren) {
          if (clause.type !== 'for_in_clause') continue;
          const right = clause.childForFieldName('right');
          const names = new Set<string>();
          pyTargetNames(clause.childForFieldName('left'), names);
          if (names.has(name) && !(right && right.startIndex <= node.startIndex && node.endIndex <= right.endIndex)) return null;
        }
      }
      if (type === 'module') { const b = bindingsOf(cur); return b.get(name) ?? null; }
      if (type === 'function_definition' || type === 'lambda') {
        const b = bindingsOf(cur);
        if (b.has(name)) return b.get(name)!;
        crossedFunction = true;
      } else if (type === 'class_definition' && !crossedFunction) {
        const b = bindingsOf(cur);
        if (b.has(name)) return b.get(name)!;
      }
    }
    return null;
  };
  const inImport = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'import_statement' || p.type === 'import_from_statement') return true;
      if (PY_SCOPES.has(p.type) || p.type === 'module') return false;
    }
    return false;
  };

  for (const node of root.descendantsOfType('attribute')) {
    const object = node.childForFieldName('object');
    const attr = node.childForFieldName('attribute')?.text as string | undefined;
    if (object?.type !== 'identifier' || !attr) continue;
    const module = resolve(object, object.text);
    if (module === 'os' && (attr === 'environ' || attr === 'getenv')) out.push({ line: lineOf(node), name: 'env', text: `os.${attr}` });
    else if (module === 'sys' && attr === 'argv') out.push({ line: lineOf(node), name: 'argv', text: 'sys.argv' });
  }
  // `from os import environ, getenv` / `from sys import argv`: the bare name is the access. Only a
  // name some such import binds (under its alias) is looked up.
  const bare = new Set<string>();
  for (const statement of root.descendantsOfType('import_from_statement')) {
    const module = statement.childForFieldName('module_name')?.text;
    if (module !== 'os' && module !== 'sys') continue;
    for (const i of statement.childrenForFieldName('name')) {
      const local = i.type === 'aliased_import' ? i.childForFieldName('alias')?.text : i.text;
      if (local) bare.add(local);
    }
  }
  if (bare.size) {
    for (const node of root.descendantsOfType('identifier')) {
      const text = node.text as string;
      const parent = node.parent;
      if (!bare.has(text) || !parent || inImport(node)) continue;
      if (parent.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id) continue;
      if (parent.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id) continue;
      const target = resolve(node, text);
      if (target === 'os.environ' || target === 'os.getenv') out.push({ line: lineOf(node), name: 'env', text: target });
      else if (target === 'sys.argv') out.push({ line: lineOf(node), name: 'argv', text: target });
    }
  }
  return out;
}

// ─── Go ─────────────────────────────────────────────────────────────────────────────────────

const GO_FUNCTIONS = new Set(['function_declaration', 'method_declaration', 'func_literal']);

function goAmbient(root: Node): AmbientAccess[] {
  // The local names of the imports of "os": `os`, or the alias.
  const locals = new Set<string>();
  for (const spec of root.descendantsOfType('import_spec')) {
    const path = String(spec.childForFieldName('path')?.text ?? '').replace(/^["`]|["`]$/g, '');
    if (path !== 'os') continue;
    const alias = spec.childForFieldName('name')?.text as string | undefined;
    if (alias === undefined || alias === 'os') locals.add('os');
    else if (alias !== '_' && alias !== '.') locals.add(alias);
  }
  if (!locals.size) return [];
  const out: AmbientAccess[] = [];
  // Every local declaration with the node it is visible in and where it starts to be: a parameter in its
  // function, a `:=`, `var` or `range` name in its block (or `if`, `for`, `switch` or case) after it.
  const GO_BLOCKS = new Set(['block', 'if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement',
    'expression_case', 'default_case', 'type_case', 'communication_case']);
  const declarations: Array<{ name: string; scope: Node; from: number }> = [];
  const enclosing = (n: Node, types: Set<string>) => { let p = n.parent; while (p && !types.has(p.type)) p = p.parent; return p; };
  for (const d of root.descendantsOfType(['parameter_declaration', 'variadic_parameter_declaration'])) {
    const fn = enclosing(d, GO_FUNCTIONS);
    if (fn) for (const id of d.childrenForFieldName('name')) declarations.push({ name: id.text, scope: fn, from: -1 });
  }
  for (const d of root.descendantsOfType(['var_spec', 'const_spec'])) {
    const scope = enclosing(d, GO_BLOCKS);
    if (scope) for (const id of d.childrenForFieldName('name')) declarations.push({ name: id.text, scope, from: d.endIndex });
  }
  for (const d of root.descendantsOfType(['short_var_declaration', 'range_clause'])) {
    const scope = enclosing(d, GO_BLOCKS);
    if (scope) for (const id of d.childForFieldName('left')?.namedChildren ?? []) if (id.type === 'identifier') declarations.push({ name: id.text, scope, from: d.type === 'range_clause' ? -1 : d.endIndex });
  }
  const shadowed = (node: Node, name: string) => declarations.some((d) =>
    d.name === name && d.scope.startIndex <= node.startIndex && node.endIndex <= d.scope.endIndex && node.startIndex >= d.from);
  for (const node of root.descendantsOfType('selector_expression')) {
    const operand = node.childForFieldName('operand');
    const field = node.childForFieldName('field')?.text as string | undefined;
    if (operand?.type !== 'identifier' || !field || !locals.has(operand.text) || shadowed(node, operand.text)) continue;
    if (GO_ENV.has(field)) out.push({ line: lineOf(node), name: 'env', text: `os.${field}` });
    else if (field === 'Args') out.push({ line: lineOf(node), name: 'argv', text: 'os.Args' });
  }
  return out;
}
