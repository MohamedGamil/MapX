import { Parser, type Node } from 'web-tree-sitter';
import type { ExtractedReference, VueMappedMember, VueThisScope } from '../../types.js';
import { getBuiltinLanguages } from '../../languages/registry.js';

/**
 * Vue Options API member resolution (M3-03, edge contract rule 6 in docs/baton/iterations/M3-01.md).
 *
 * The parser side finds a `<script>` block's options object and gives each `this.x()` call inside
 * it a `VueThisScope`: whether `x` is one of the component's own members, the mixins it lists, and
 * the map-helper entry that introduces `x`. The scanner side (`resolveThisMember`) walks
 * `THIS_MEMBER_STEPS` in order; a `this.x()` that no step resolves gets no edge.
 */

/** An Options API component as written in one script block. */
export interface OptionsComponent {
  /** Keys of `methods` and `computed`, and function-valued top-level options (hooks, `data`, `setup`). */
  members: Set<string>;
  /** Mixin modules in merge order (`extends` first, then `mixins` as listed); null = this file. */
  mixins: (string | null)[];
  /** Local names spread from Vuex / Pinia map helpers in `methods` / `computed`. */
  mapped: Map<string, VueMappedMember>;
  /** `this.x()` calls inside the options object, by script line (1-based). */
  thisCalls: { name: string; line: number }[];
}

const COMPONENT_WRAPPERS = new Set(['defineComponent', 'defineNuxtComponent', 'Vue.extend']);
const MAP_HELPERS = new Set(['mapActions', 'mapGetters', 'mapState', 'mapMutations', 'mapWritableState']);
const TRANSPARENT = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression']);
const FUNCTION_VALUES = new Set(['function_expression', 'function', 'arrow_function', 'generator_function']);

let parserPromise: Promise<Parser> | null = null;
function scriptParser(): Promise<Parser> {
  // Loaded on first use: the scanner imports this module for `resolveThisMember` only.
  return (parserPromise ??= import('../wasm-parser.js')
    .then(({ loadLanguage }) => loadLanguage(getBuiltinLanguages().typescript))
    .then((language) => {
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    }));
}

/**
 * Gives every `this.x()` call reference of an Options API script block its `vueThis` scope.
 * `refs` are the block's references with block-relative lines. A block without an options
 * object (`<script setup>`, class components, plain modules) is left as it is.
 */
export async function annotateThisCalls(code: string, refs: ExtractedReference[]): Promise<void> {
  if (!/\bthis\s*\./.test(code)) return;
  let component: OptionsComponent | null;
  try {
    component = await analyzeOptionsComponent(code);
  } catch {
    return;
  }
  if (!component || component.thisCalls.length === 0) return;
  const calls = new Set(component.thisCalls.map((c) => `${c.line}:${c.name}`));
  for (const ref of refs) {
    if (ref.referenceType === 'call' && calls.has(`${ref.startLine}:${ref.targetName}`)) {
      ref.vueThis = vueThisScope(component, ref.targetName);
    }
  }
}

/** Where `this.<name>` may be declared for this component (also usable for template calls). */
export function vueThisScope(component: OptionsComponent, name: string): VueThisScope {
  const mapped = component.mapped.get(name);
  return { own: component.members.has(name), mixins: component.mixins, ...(mapped ? { mapped } : {}) };
}

export async function analyzeOptionsComponent(code: string): Promise<OptionsComponent | null> {
  const parser = await scriptParser();
  const tree = parser.parse(code);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    const options = optionsObject(root);
    if (!options) return null;
    const imports = importSources(root);
    const component: OptionsComponent = { members: new Set(), mixins: [], mapped: new Map(), thisCalls: [] };
    let base: string | null | undefined;

    for (const prop of options.namedChildren) {
      const name = keyOf(prop);
      const value = valueOf(prop);
      if (!name || !value) continue;
      if ((name === 'methods' || name === 'computed') && value.type === 'object') {
        for (const member of value.namedChildren) {
          if (member.type === 'spread_element') collectMapped(member.namedChild(0), component.mapped);
          else {
            const memberName = keyOf(member);
            if (memberName) component.members.add(memberName);
          }
        }
      } else if (name === 'mixins' && value.type === 'array') {
        for (const mixin of value.namedChildren) {
          if (mixin.type === 'identifier') component.mixins.push(imports.get(mixin.text) ?? null);
          else if (mixin.type === 'object') component.mixins.push(null);
        }
      } else if (name === 'extends' && value.type === 'identifier') {
        base = imports.get(value.text) ?? null;
      } else if (prop.type === 'method_definition' || FUNCTION_VALUES.has(value.type)) {
        component.members.add(name);
      }
    }
    // `extends` merges before the mixins, so it has the lowest priority.
    if (base !== undefined) component.mixins.unshift(base);
    collectThisCalls(options, component.thisCalls);
    return component;
  } finally {
    tree.delete();
  }
}

/** The object of `export default { … }`, `export default defineComponent({ … })` or `export default X`. */
function optionsObject(root: Node): Node | null {
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement') continue;
    const value = statement.childForFieldName('value');
    if (value) return unwrapOptions(value, root, 0);
  }
  return null;
}

function unwrapOptions(node: Node | null, root: Node, depth: number): Node | null {
  if (!node || depth > 4) return null;
  if (node.type === 'object') return node;
  if (TRANSPARENT.has(node.type)) return unwrapOptions(node.namedChild(0), root, depth + 1);
  if (node.type === 'call_expression') {
    if (!COMPONENT_WRAPPERS.has(node.childForFieldName('function')?.text ?? '')) return null;
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    return unwrapOptions(args[args.length - 1] ?? null, root, depth + 1);
  }
  if (node.type === 'identifier') {
    // `const Component = { … }; export default Component`
    for (const statement of root.namedChildren) {
      if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') continue;
      for (const declarator of statement.namedChildren) {
        if (declarator.type === 'variable_declarator' && declarator.childForFieldName('name')?.text === node.text) {
          return unwrapOptions(declarator.childForFieldName('value'), root, depth + 1);
        }
      }
    }
  }
  return null;
}

/** Local binding → module specifier, for the file's static imports. */
function importSources(root: Node): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') continue;
    const source = stringValue(statement.childForFieldName('source'));
    const clause = statement.namedChildren.find((c) => c.type === 'import_clause');
    if (source === null || !clause) continue;
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') sources.set(part.text, source);
      else if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c.type === 'identifier');
        if (local) sources.set(local.text, source);
      } else if (part.type === 'named_imports') {
        for (const specifier of part.namedChildren) {
          const local = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
          if (specifier.type === 'import_specifier' && local) sources.set(local.text, source);
        }
      }
    }
  }
  return sources;
}

/**
 * `...mapActions('ns', ['A'])`, `...mapGetters(['a'])`, `...mapState('ns', { local: 'remote' })`,
 * `...mapActions(useCartStore, ['checkout'])`: the local names, with what M3-05 needs to resolve them.
 */
function collectMapped(call: Node | null, mapped: Map<string, VueMappedMember>): void {
  if (call?.type !== 'call_expression') return;
  const helper = call.childForFieldName('function')?.text ?? '';
  if (!MAP_HELPERS.has(helper)) return;
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const namespace = args.length >= 2 ? (stringValue(args[0]) ?? args[0].text) : null;
  const names = args[args.length - 1];
  if (names?.type === 'array') {
    for (const element of names.namedChildren) {
      const name = stringValue(element);
      if (name) mapped.set(name, { helper, namespace, name });
    }
  } else if (names?.type === 'object') {
    for (const prop of names.namedChildren) {
      const local = keyOf(prop);
      if (local) mapped.set(local, { helper, namespace, name: stringValue(valueOf(prop)) });
    }
  }
}

/**
 * `this.x()` calls under the options object. A nested `function () {}` that is not itself a
 * member rebinds `this`, so its calls are left to the default resolution.
 */
function collectThisCalls(options: Node, out: OptionsComponent['thisCalls']): void {
  const stack: Node[] = [options];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ((node.type === 'function_expression' || node.type === 'function' || node.type === 'function_declaration') && node.parent?.type !== 'pair') continue;
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const property = callee?.type === 'member_expression' ? callee.childForFieldName('property') : null;
      if (callee?.childForFieldName('object')?.type === 'this' && property?.type === 'property_identifier') {
        out.push({ name: property.text, line: node.startPosition.row + 1 });
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
}

function keyOf(prop: Node): string | null {
  if (prop.type === 'shorthand_property_identifier') return prop.text;
  const key = prop.type === 'pair' ? prop.childForFieldName('key') : prop.type === 'method_definition' ? prop.childForFieldName('name') : null;
  if (!key) return null;
  if (key.type === 'property_identifier' || key.type === 'identifier') return key.text;
  return stringValue(key);
}

function valueOf(prop: Node): Node | null {
  if (prop.type === 'pair') return prop.childForFieldName('value');
  if (prop.type === 'method_definition' || prop.type === 'shorthand_property_identifier') return prop;
  return null;
}

function stringValue(node: Node | null | undefined): string | null {
  if (node?.type !== 'string') return null;
  return node.namedChildren.find((c) => c.type === 'string_fragment')?.text ?? '';
}

/** What the scanner provides to resolve a `this.x()` reference. */
export interface ThisMemberContext {
  /** The component's file. */
  sourceFile: string;
  /** The indexed file an import specifier of the component's file resolves to. */
  resolveImport(specifier: string): string | null;
  /** True when `file` declares a symbol named `name`. */
  defines(file: string, name: string): boolean;
  /** The scanner's name-only lookup, for a step that does not resolve precisely yet. */
  byName(name: string): string | null;
}

/** A resolution step: the target file, null for "no edge", or undefined to defer to the next step. */
export type ThisMemberStep = (name: string, scope: VueThisScope, ctx: ThisMemberContext) => string | null | undefined;

/** Contract rule 6, in order. */
export const THIS_MEMBER_STEPS: ThisMemberStep[] = [
  // 1. A member of the SFC itself.
  (_name, scope, ctx) => (scope.own ? ctx.sourceFile : undefined),
  // 2. A member of a mixin the component lists, in the mixin's file. A later mixin overrides an
  //    earlier one, as in Vue's option merge.
  (name, scope, ctx) => {
    for (let i = scope.mixins.length - 1; i >= 0; i--) {
      const specifier = scope.mixins[i];
      const file = specifier === null ? ctx.sourceFile : ctx.resolveImport(specifier);
      if (file && ctx.defines(file, name)) return file;
    }
    return undefined;
  },
  // 3. A name mapped by the component's Vuex / Pinia map helpers. M3-05 resolves `scope.mapped`
  //    through the store; until then, the name-only lookup used before M3-03.
  (name, scope, ctx) => (scope.mapped ? ctx.byName(name) : undefined),
];

/** The file declaring the `this.<name>` member, or null when no step resolves it (no edge). */
export function resolveThisMember(name: string, scope: VueThisScope, ctx: ThisMemberContext): string | null {
  for (const step of THIS_MEMBER_STEPS) {
    const file = step(name, scope, ctx);
    if (file !== undefined) return file;
  }
  return null;
}
