import type { Node } from 'web-tree-sitter';
import type { ExtractedReference, VueMappedMember, VueThisScope } from '../../types.js';
import { importSources, isFunctionMember, keyOf, optionsObject, valueOf, withScriptTree } from './vue-ast.js';
import { mapHelperEntries, resolveStoreTarget, type VueResolveContext, type VueTarget } from './vue-stores.js';

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
  /** `this.x()` calls inside a nested function that rebinds `this`: no edge (M3-02-R1). */
  reboundCalls: { name: string; line: number }[];
}

/** A `this` that is not the component: no step resolves it, so the call gets no edge. */
const NOT_THE_COMPONENT: VueThisScope = { own: false, mixins: [] };

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
  if (!component || component.thisCalls.length + component.reboundCalls.length === 0) return;
  const calls = new Set(component.thisCalls.map((c) => `${c.line}:${c.name}`));
  const rebound = new Set(component.reboundCalls.map((c) => `${c.line}:${c.name}`));
  for (const ref of refs) {
    if (ref.referenceType !== 'call') continue;
    const key = `${ref.startLine}:${ref.targetName}`;
    if (calls.has(key)) ref.vueThis = vueThisScope(component, ref.targetName);
    // Never the default resolution: that would link any file defining the name.
    else if (rebound.has(key)) ref.vueThis = NOT_THE_COMPONENT;
  }
}

/** Where `this.<name>` may be declared for this component (also usable for template calls). */
export function vueThisScope(component: OptionsComponent, name: string): VueThisScope {
  const mapped = component.mapped.get(name);
  return { own: component.members.has(name), mixins: component.mixins, ...(mapped ? { mapped } : {}) };
}

export async function analyzeOptionsComponent(code: string): Promise<OptionsComponent | null> {
  return withScriptTree(code, (root) => {
    const options = optionsObject(root);
    if (!options) return null;
    const imports = importSources(root);
    const component: OptionsComponent = { members: new Set(), mixins: [], mapped: new Map(), thisCalls: [], reboundCalls: [] };
    let base: string | null | undefined;

    for (const prop of options.namedChildren) {
      const name = keyOf(prop);
      const value = valueOf(prop);
      if (!name || !value) continue;
      if ((name === 'methods' || name === 'computed') && value.type === 'object') {
        for (const member of value.namedChildren) {
          if (member.type === 'spread_element') {
            for (const { local, helper, name: mappedName, target } of mapHelperEntries(member.namedChild(0), imports)) {
              component.mapped.set(local, { helper, name: mappedName, target });
            }
          } else {
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
      } else if (isFunctionMember(prop)) {
        component.members.add(name);
      }
    }
    // `extends` merges before the mixins, so it has the lowest priority.
    if (base !== undefined) component.mixins.unshift(base);
    collectThisCalls(options, component);
    return component;
  });
}

const NON_ARROW_FUNCTIONS = new Set([
  'function_expression', 'function', 'function_declaration', 'generator_function', 'generator_function_declaration', 'method_definition',
]);
/** Literal nodes through which a function is still held by the options object itself. */
const OPTION_LITERALS = new Set(['object', 'pair', 'array']);
/** Wrappers that call the function with the `this` they are called with (lodash, underscore). */
const THIS_PRESERVING_WRAPPERS = new Set(['debounce', 'throttle', 'memoize']);
/** Vue 2 instance methods that call their callback with the component as `this`. */
const VM_CALLBACKS = new Set(['$on', '$once', '$nextTick', '$watch']);

/**
 * A non-arrow function that still runs with the component's `this` (review 2026-10-31):
 * `function () {}.bind(this)`; `debounce(function () {}, 300)` or `_.throttle(function () {})`,
 * whose wrapper is called as a method and passes its `this` on; and Vue 2's `this.$on`, `$once`,
 * `$nextTick` and `$watch` callbacks. `socket.once(…, function () {})` rebinds `this`.
 */
function keepsThis(fn: Node): boolean {
  const parent = fn.parent;
  if (parent?.type === 'member_expression' && parent.childForFieldName('property')?.text === 'bind') {
    const call = parent.parent;
    return call?.type === 'call_expression' && call.childForFieldName('arguments')?.namedChildren[0]?.type === 'this';
  }
  if (parent?.type === 'arguments' && parent.parent?.type === 'call_expression') {
    const callee = parent.parent.childForFieldName('function');
    if (callee?.type === 'member_expression') {
      const name = callee.childForFieldName('property')?.text ?? '';
      const object = callee.childForFieldName('object');
      // `this.$on('x', function () {})`: Vue binds the component. `_.debounce(fn)`: lodash passes it on.
      if (object?.type === 'this') return VM_CALLBACKS.has(name);
      return THIS_PRESERVING_WRAPPERS.has(name) && /^(_|lodash|underscore)$/.test(object?.text ?? '');
    }
    return !!callee && THIS_PRESERVING_WRAPPERS.has(callee.text);
  }
  return false;
}

/**
 * `this.x()` calls under the options object. `this` is the component inside the functions the
 * options literal holds (members, hooks, `watch` handlers, computed `get` / `set`, inline mixins)
 * and in arrow functions within them. Any other non-arrow function (a callback `function () {}`,
 * a nested object's method) and an arrow held by the literal itself rebind it: their calls go to
 * `reboundCalls` (M3-02-R1). `function () {}.bind(this)` and a function passed to a `this`-preserving
 * wrapper (`debounce`, `throttle`) keep the component's `this`.
 */
function collectThisCalls(options: Node, component: OptionsComponent): void {
  // held: every node between the options object and this one is an object, pair or array.
  const stack: { node: Node; held: boolean; rebound: boolean }[] = [{ node: options, held: true, rebound: false }];
  while (stack.length > 0) {
    const { node, held, rebound } = stack.pop()!;
    const fn = NON_ARROW_FUNCTIONS.has(node.type) || node.type === 'arrow_function';
    // A held non-arrow function is a member; a held arrow keeps the module's `this`.
    const rebinds = fn && (NON_ARROW_FUNCTIONS.has(node.type) ? !held && !keepsThis(node) : held);
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const property = callee?.type === 'member_expression' ? callee.childForFieldName('property') : null;
      if (callee?.childForFieldName('object')?.type === 'this' && property?.type === 'property_identifier') {
        // Dated by the name node, as the generic extraction dates the reference.
        (rebound ? component.reboundCalls : component.thisCalls).push({ name: property.text, line: property.startPosition.row + 1 });
      }
    }
    const next = { held: held && OPTION_LITERALS.has(node.type), rebound: rebound || rebinds };
    for (const child of node.namedChildren) stack.push({ node: child, ...next });
  }
}

/** A resolution step: the target, null for "no edge", or undefined to defer to the next step. */
export type ThisMemberStep = (name: string, scope: VueThisScope, ctx: VueResolveContext) => VueTarget | null | undefined;

/** Contract rule 6, in order. */
export const THIS_MEMBER_STEPS: ThisMemberStep[] = [
  // 1. A member of the SFC itself.
  (name, scope, ctx) => (scope.own ? { file: ctx.sourceFile, symbol: name } : undefined),
  // 2. A member of a mixin the component lists, in the mixin's file. A later mixin overrides an
  //    earlier one, as in Vue's option merge.
  (name, scope, ctx) => {
    for (let i = scope.mixins.length - 1; i >= 0; i--) {
      const specifier = scope.mixins[i];
      const file = specifier === null ? ctx.sourceFile : ctx.resolveImport(specifier);
      if (file && ctx.defines(file, name)) return { file, symbol: name };
    }
    return undefined;
  },
  // 3. A name mapped by the component's Vuex / Pinia map helpers, in the store it maps from
  //    (rules 7 and 8, M3-05). `loadAll: 'FETCH_ALL'` names FETCH_ALL.
  (_name, scope, ctx) => {
    const mapped: VueMappedMember | undefined = scope.mapped;
    if (!mapped) return undefined;
    return mapped.name && mapped.target ? resolveStoreTarget(mapped.name, mapped.target, ctx) : null;
  },
];

/** The member `this.<name>` names, or null when no step resolves it (no edge). */
export function resolveThisMember(name: string, scope: VueThisScope, ctx: VueResolveContext): VueTarget | null {
  for (const step of THIS_MEMBER_STEPS) {
    const target = step(name, scope, ctx);
    if (target !== undefined) return target;
  }
  return null;
}
