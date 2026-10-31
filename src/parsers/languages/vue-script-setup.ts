import type { Node } from 'web-tree-sitter';
import type { ExtractedReference } from '../../types.js';
import { keyOf, optionsObject, stringValue, valueOf, withScriptTree } from './vue-ast.js';
import type { VueResolveHint } from './vue-template.js';

/**
 * `<script setup>` macros and composables (M3-04; Vue edge contract in docs/baton/iterations/M3-01.md).
 *
 * - Rule 1 metadata: the component's interface, `props` / `emits` (and `exposes`, not scored), from
 *   `defineProps` / `withDefaults` / `defineEmits` / `defineExpose`, and from Options API `props` / `emits`.
 * - Rule 4, script code: a call to an imported composable `useX()`, and a call to a function
 *   destructured from an imported call (`const { persist } = usePreferences()`), get M3-02's
 *   `metadata.vue` hint, so the scanner resolves them through the import (the composable's file)
 *   and never by name. Value flow is followed no further than that destructuring.
 */

/** A component's declared interface; a list is absent when nothing declares it. */
export interface VueInterface {
  props?: string[];
  emits?: string[];
  exposes?: string[];
}

export interface ScriptBlockAnalysis {
  interface: VueInterface;
  /** Resolution hints for call references, by `line:name` (block-relative lines, 1-based). */
  hints: Map<string, VueResolveHint>;
}

/** A composable call: `useX`, but not a Pinia `useXStore` (rule 8, M3-05). */
const COMPOSABLE = /^use[A-Z0-9_]/;
const PINIA_STORE = /^use\w*Store$/;

interface Imported { specifier: string; imported: string }
interface Destructuring {
  /** Byte range of the scope the binding is visible in (the enclosing block or program). */
  start: number;
  end: number;
  /** Local name → the name destructured from the call's result. */
  names: Map<string, string>;
  specifier: string;
}

/** Analyses one script block (its code, as the block holds it). Null when it cannot be parsed. */
export async function analyzeScriptBlock(code: string): Promise<ScriptBlockAnalysis | null> {
  return withScriptTree(code, (root) => {
    const imports = importBindings(root);
    const iface: VueInterface = {};
    const destructurings: Destructuring[] = [];
    const calls: Node[] = [];

    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'call_expression') {
        const callee = node.childForFieldName('function');
        if (callee?.type === 'identifier') {
          const args = node.childForFieldName('arguments')?.namedChildren ?? [];
          const typeArg = node.childForFieldName('type_arguments')?.namedChildren[0] ?? null;
          if (callee.text === 'defineProps') add(iface, 'props', typeArg ? typeMembers(typeArg, root) : runtimeNames(args[0]));
          else if (callee.text === 'defineEmits') add(iface, 'emits', typeArg ? emitTypeNames(typeArg, root) : runtimeNames(args[0]));
          else if (callee.text === 'defineExpose') add(iface, 'exposes', runtimeNames(args[0]));
          else calls.push(node);
        }
      } else if (node.type === 'variable_declarator') {
        const d = destructuring(node, imports);
        if (d) destructurings.push(d);
      }
      for (const child of node.namedChildren) stack.push(child);
    }

    // Options API `props` / `emits` (array or object) fill the same lists.
    const options = optionsObject(root);
    for (const prop of options?.namedChildren ?? []) {
      const key = keyOf(prop);
      if (key === 'props' || key === 'emits') add(iface, key, runtimeNames(valueOf(prop)));
    }

    const hints = new Map<string, VueResolveHint>();
    for (const call of calls) {
      const callee = call.childForFieldName('function')!;
      const hint = composableHint(callee.text, call.startIndex, destructurings, imports);
      if (hint) hints.set(`${call.startPosition.row + 1}:${callee.text}`, hint);
    }
    return { interface: iface, hints };
  });
}

/** Gives the block's composable call references (block-relative lines) their resolution hint. */
export function annotateComposableCalls(analysis: ScriptBlockAnalysis, refs: ExtractedReference[]): void {
  if (analysis.hints.size === 0) return;
  for (const ref of refs) {
    // References another pass already scoped (`this.x()`, Vuex / Pinia, M3-03 and M3-05) keep their resolution.
    if (ref.referenceType !== 'call' || ref.vueThis || ref.vueStore || ref.metadata?.vue) continue;
    const hint = analysis.hints.get(`${ref.startLine}:${ref.targetName}`);
    if (hint) ref.metadata = { ...ref.metadata, vue: hint };
  }
}

/** The component symbol's metadata for the interfaces of its script blocks (lists merged, deduplicated). */
export function interfaceMetadata(interfaces: VueInterface[]): VueInterface {
  const out: VueInterface = {};
  for (const iface of interfaces) {
    for (const key of ['props', 'emits', 'exposes'] as const) add(out, key, iface[key] ?? null);
  }
  return out;
}

function add(iface: VueInterface, key: keyof VueInterface, names: string[] | null): void {
  if (!names) return;
  const list = (iface[key] ??= []);
  for (const name of names) if (!list.includes(name)) list.push(name);
}

/**
 * Where a call to `name` at `offset` resolves: the module of the innermost destructuring in scope
 * that binds `name` (to the destructured name), else, for an imported composable, its module.
 */
function composableHint(name: string, offset: number, destructurings: Destructuring[], imports: Map<string, Imported>): VueResolveHint | null {
  let best: Destructuring | null = null;
  for (const d of destructurings) {
    if (d.names.has(name) && d.start <= offset && offset < d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
  }
  if (best) return { from: [{ specifier: best.specifier, name: best.names.get(name)! }] };
  const imp = imports.get(name);
  if (!imp || !COMPOSABLE.test(name) || PINIA_STORE.test(name)) return null;
  // A default import is looked up under the local name (`export default function useUser`).
  return { from: [{ specifier: imp.specifier, name: imp.imported === 'default' ? name : imp.imported }] };
}

/** `const { a, b: c } = [await] useX(…)` where `useX` is imported: the names, the module and the scope. */
function destructuring(declarator: Node, imports: Map<string, Imported>): Destructuring | null {
  const pattern = declarator.childForFieldName('name');
  let value = declarator.childForFieldName('value');
  if (value?.type === 'await_expression') value = value.namedChild(0);
  if (pattern?.type !== 'object_pattern' || value?.type !== 'call_expression') return null;
  const fn = value.childForFieldName('function');
  const imp = fn?.type === 'identifier' ? imports.get(fn.text) : undefined;
  if (!imp) return null;
  const names = new Map<string, string>();
  for (const part of pattern.namedChildren) {
    if (part.type === 'shorthand_property_identifier_pattern') names.set(part.text, part.text);
    else if (part.type === 'object_assignment_pattern') {
      const left = part.childForFieldName('left');
      if (left?.type === 'shorthand_property_identifier_pattern') names.set(left.text, left.text);
    } else if (part.type === 'pair_pattern') {
      const key = part.childForFieldName('key');
      let local = part.childForFieldName('value');
      if (local?.type === 'assignment_pattern') local = local.childForFieldName('left');
      if (key?.type === 'property_identifier' && local?.type === 'identifier') names.set(local.text, key.text);
    }
  }
  let scope = declarator.parent;
  while (scope && scope.type !== 'statement_block' && scope.type !== 'program') scope = scope.parent;
  return scope && names.size > 0 ? { start: scope.startIndex, end: scope.endIndex, names, specifier: imp.specifier } : null;
}

/** Local binding → module specifier and imported name (`default` for a default import). */
function importBindings(root: Node): Map<string, Imported> {
  const bindings = new Map<string, Imported>();
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') continue;
    const specifier = stringValue(statement.childForFieldName('source'));
    const clause = statement.namedChildren.find((c) => c.type === 'import_clause');
    if (specifier === null || !clause || /^import\s+type\b/.test(statement.text)) continue;
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') bindings.set(part.text, { specifier, imported: 'default' });
      else if (part.type === 'named_imports') {
        for (const s of part.namedChildren) {
          const name = s.childForFieldName('name');
          const local = s.childForFieldName('alias') ?? name;
          if (s.type === 'import_specifier' && name && local) bindings.set(local.text, { specifier, imported: name.text });
        }
      }
    }
  }
  return bindings;
}

/** Runtime declaration: `['a', 'b']` (strings) or `{ a: …, b }` (keys). */
function runtimeNames(node: Node | null | undefined): string[] | null {
  if (node?.type === 'array') return node.namedChildren.map(stringValue).filter((s): s is string => !!s);
  if (node?.type === 'object') return node.namedChildren.map(keyOf).filter((s): s is string => !!s);
  return null;
}

/** Property names of a type: an object type, a same-block interface / type alias, or an intersection. */
function typeMembers(type: Node, root: Node, depth = 0): string[] | null {
  const body = objectType(type, root, depth);
  if (!body) return null;
  if (Array.isArray(body)) return body.flatMap((t) => typeMembers(t, root, depth + 1) ?? []);
  const names: string[] = [];
  for (const member of body.namedChildren) {
    if (member.type !== 'property_signature') continue;
    const name = member.childForFieldName('name');
    const text = name?.type === 'string' ? stringValue(name) : name?.text;
    if (text) names.push(text);
  }
  return names;
}

/**
 * Event names of a `defineEmits` type: the string literal types of each call signature's first
 * parameter (`(e: 'a' | 'b', …): void`), and the keys of the 3.3 form (`{ a: [x: number] }`).
 */
function emitTypeNames(type: Node, root: Node): string[] | null {
  const body = objectType(type, root, 0);
  if (!body || Array.isArray(body)) return body ? body.flatMap((t) => emitTypeNames(t, root) ?? []) : null;
  const names: string[] = [];
  for (const member of body.namedChildren) {
    if (member.type === 'call_signature') {
      const first = member.childForFieldName('parameters')?.namedChildren[0];
      const annotation = first?.childForFieldName('type')?.namedChild(0);
      if (annotation) names.push(...literalStrings(annotation));
    } else if (member.type === 'property_signature') {
      const name = member.childForFieldName('name');
      const text = name?.type === 'string' ? stringValue(name) : name?.text;
      if (text) names.push(text);
    }
  }
  return names;
}

/** The object type (`{ … }` / interface body) a type node denotes, or its parts for an intersection. */
function objectType(type: Node, root: Node, depth: number): Node | Node[] | null {
  if (depth > 4) return null;
  if (type.type === 'object_type' || type.type === 'interface_body') return type;
  if (type.type === 'intersection_type' || type.type === 'parenthesized_type') return type.namedChildren;
  if (type.type !== 'type_identifier') return null;
  for (const statement of root.namedChildren) {
    const decl = statement.type === 'export_statement' ? statement.namedChild(0) : statement;
    if (decl?.childForFieldName('name')?.text !== type.text) continue;
    if (decl.type === 'interface_declaration') return decl.childForFieldName('body');
    if (decl.type === 'type_alias_declaration') {
      const value = decl.childForFieldName('value');
      return value ? objectType(value, root, depth + 1) : null;
    }
  }
  return null;
}

function literalStrings(type: Node): string[] {
  if (type.type === 'literal_type') {
    const s = stringValue(type.namedChild(0));
    return s ? [s] : [];
  }
  if (type.type === 'union_type' || type.type === 'parenthesized_type') return type.namedChildren.flatMap(literalStrings);
  return [];
}

/**
 * Where a module re-exports `name` (`export { name } from 's'`, `export { x as name } from 's'`,
 * `export * from 's'`), so the scanner can follow a composable through a barrel `index.ts`.
 */
export function reExportsOf(text: string, name: string): { specifier: string; name: string }[] {
  const out: { specifier: string; name: string }[] = [];
  for (const m of text.matchAll(/\bexport\s*(?:\*|\{([^}]*)\})\s*from\s*(['"])([^'"]+)\2/g)) {
    if (m[1] === undefined) { out.push({ specifier: m[3]!, name }); continue; }
    for (const part of m[1].split(',')) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      // `export { default as useAuth } from './useAuth'`: the module's default export, named useAuth.
      if (p && (p[2] ?? p[1]) === name) out.push({ specifier: m[3]!, name: p[1] === 'default' ? name : p[1]! });
    }
  }
  return out;
}
