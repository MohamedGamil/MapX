import type { Node } from 'web-tree-sitter';
import type { ExtractedReference, ParseResult, VueStoreTarget, VuexKind } from '../../types.js';
import { FUNCTION_VALUES, importSources, isFunctionMember, keyOf, objectOf, optionsObject, stringValue, topLevelDeclarator, valueOf, withScriptTree } from './vue-ast.js';

/**
 * Vuex and Pinia resolution (M3-05, edge contract rules 7 and 8 in docs/baton/iterations/M3-01.md).
 *
 * Parse side (`annotateStoreRefs`, run by the JavaScript and TypeScript parsers, so also on `.vue`
 * script blocks): records a Vuex store file's model in `fileMetadata.vuex`, and gives store calls a
 * `vueStore` target (namespace and kind, or Pinia store import). Resolution side
 * (`resolveStoreTarget`): the member in that store's file, or no edge; never a lookup by name alone.
 */

/** A Vuex store root or module as written in one file. Stored in `files.metadata.vuex`. */
export interface VuexModuleInfo {
  root?: boolean;
  namespaced: boolean;
  members: Partial<Record<VuexKind, string[]>>;
  /** Registered name → import specifier of the module file, or the module written inline. */
  modules: Record<string, string | VuexModuleInfo>;
}

/** What the scanner provides to resolve Vue references. */
export interface VueResolveContext {
  /** The referring file. */
  sourceFile: string;
  /** The indexed file an import specifier of `from` (default: the referring file) resolves to. */
  resolveImport(specifier: string, from?: string): string | null;
  /** True when `file` declares a symbol named `name`. */
  defines(file: string, name: string): boolean;
  /** This resolution phase's Vuex store models, by file. */
  vuexFiles(): Map<string, VuexModuleInfo>;
}

export interface VueTarget {
  file: string;
  symbol: string;
}

const MAP_HELPER_KINDS: Record<string, VuexKind> = {
  mapActions: 'actions', mapMutations: 'mutations', mapGetters: 'getters', mapState: 'state', mapWritableState: 'state',
};
const VUEX_KINDS: VuexKind[] = ['state', 'getters', 'mutations', 'actions'];
const CALL_KINDS: Record<string, VuexKind> = { dispatch: 'actions', commit: 'mutations' };
/** Keys that make an exported object a Vuex module rather than a component. */
const MODULE_KEYS = new Set(['namespaced', 'getters', 'mutations', 'actions']);
const COMPONENT_KEYS = new Set(['methods', 'components', 'props', 'data', 'setup', 'template', 'render', 'computed']);
/** `useCartStore`, not Vuex 4's `useStore`. */
const PINIA_HOOK = /^use[A-Z0-9_$][\w$]*Store$/;
const STORE_HINT = /\$store|\b(?:dispatch|commit)\s*\(|\bmap(?:Actions|Getters|State|Mutations|WritableState)\b|\buse[A-Z0-9_$][\w$]*Store\b|\b(?:mutations|actions|getters|namespaced)\b|\b(?:create)?Store\s*\(/;
const MODULE_HINT = /\b(?:mutations|actions|getters|namespaced|modules)\b/;

/** Mapped names of a map-helper call, with the store member each one names. */
export function mapHelperEntries(call: Node | null, imports: Map<string, string>, localHooks: Set<string> = new Set()):
  { local: string; helper: string; name: string | null; target: VueStoreTarget | null }[] {
  if (call?.type !== 'call_expression') return [];
  const helper = call.childForFieldName('function')?.text ?? '';
  const kind = MAP_HELPER_KINDS[helper];
  if (!kind) return [];
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  const first = args.length >= 2 ? args[0] : null;
  let target: VueStoreTarget | null = null;
  if (!first) target = { store: 'vuex', kind, namespace: null };
  else if (first.type === 'string') target = { store: 'vuex', kind, namespace: stringValue(first)!.replace(/\/$/, '') || null };
  else if (first.type === 'identifier' && PINIA_HOOK.test(first.text) && (imports.has(first.text) || localHooks.has(first.text))) {
    target = { store: 'pinia', hook: first.text, specifier: imports.get(first.text) ?? null };
  }
  const names = args[args.length - 1];
  const entries: ReturnType<typeof mapHelperEntries> = [];
  if (names?.type === 'array') {
    for (const element of names.namedChildren) {
      const name = stringValue(element);
      if (name) entries.push({ local: name, helper, name, target });
    }
  } else if (names?.type === 'object') {
    for (const prop of names.namedChildren) {
      const local = keyOf(prop);
      if (local) entries.push({ local, helper, name: stringValue(valueOf(prop)), target });
    }
  }
  return entries;
}

/** Adds store targets, store references and the Vuex store model to one script's parse result. */
export async function annotateStoreRefs(filePath: string, code: string, result: ParseResult): Promise<void> {
  if (!STORE_HINT.test(code)) return;
  try {
    await withScriptTree(code, (root) => new StorePass(filePath, root, result).run(code));
  } catch {
    // Store references then keep the default resolution.
  }
}

class StorePass {
  private readonly component: string | null;
  private readonly imports: Map<string, string>;
  private readonly localHooks = new Set<string>();
  private options: Node | null = null;
  private model: VuexModuleInfo | null = null;

  constructor(private readonly filePath: string, private readonly root: Node, private readonly result: ParseResult) {
    this.component = filePath.endsWith('.vue') ? (filePath.split('/').pop() ?? '').replace(/\.vue$/, '') : null;
    this.imports = importSources(root);
  }

  run(code: string): void {
    for (const top of this.root.namedChildren) {
      const statement = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
      if (statement?.type !== 'lexical_declaration' && statement?.type !== 'variable_declaration') continue;
      for (const declarator of statement.namedChildren) {
        const value = declarator.childForFieldName('value');
        const name = declarator.childForFieldName('name')?.text ?? '';
        if (value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'defineStore' && PINIA_HOOK.test(name)) this.localHooks.add(name);
      }
    }
    if (this.component) {
      this.options = optionsObject(this.root);
      this.mapHelpers();
    } else if (MODULE_HINT.test(code)) {
      this.model = this.vuexModel();
      this.result.fileMetadata = { ...this.result.fileMetadata, vuex: this.model };
    }
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'call_expression') this.call(node);
      for (const child of node.namedChildren) stack.push(child);
    }
  }

  // ── Vuex store model ──────────────────────────────────────────────────────

  private vuexModel(): VuexModuleInfo | null {
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      // new Vuex.Store({ … }) / new Store({ … }) / createStore({ … })
      const callee = node.type === 'new_expression' ? node.childForFieldName('constructor') : node.type === 'call_expression' ? node.childForFieldName('function') : null;
      const name = callee?.text ?? '';
      const isRoot = node.type === 'new_expression'
        ? name === 'Vuex.Store' || (name === 'Store' && this.imports.get('Store') === 'vuex')
        : name === 'Vuex.createStore' || (name === 'createStore' && this.imports.get('createStore') === 'vuex');
      if (isRoot) {
        const options = objectOf(node.childForFieldName('arguments')?.namedChild(0) ?? null, this.root);
        if (options) return this.moduleInfo(options, true, 0);
      }
      for (const child of node.namedChildren) stack.push(child);
    }
    for (const statement of this.root.namedChildren) {
      if (statement.type !== 'export_statement') continue;
      const options = objectOf(statement.childForFieldName('value'), this.root);
      if (!options) continue;
      const keys = options.namedChildren.map(keyOf);
      if (keys.some((k) => k && MODULE_KEYS.has(k)) && !keys.some((k) => k && COMPONENT_KEYS.has(k))) return this.moduleInfo(options, false, 0);
    }
    return null;
  }

  private moduleInfo(options: Node, root: boolean, depth: number): VuexModuleInfo {
    const info: VuexModuleInfo = { ...(root ? { root: true } : {}), namespaced: false, members: {}, modules: {} };
    for (const prop of options.namedChildren) {
      const key = keyOf(prop);
      const value = valueOf(prop);
      if (!key || !value) continue;
      if (key === 'namespaced') info.namespaced = value.text === 'true';
      else if ((VUEX_KINDS as string[]).includes(key)) {
        const kind = key as VuexKind;
        const members = kind === 'state' ? this.stateObject(value) : objectOf(value, this.root);
        if (!members) continue;
        const names: string[] = [];
        for (const member of members.namedChildren) {
          const name = keyOf(member);
          if (!name) continue;
          names.push(name);
          if (kind !== 'state' && isFunctionMember(member)) this.memberSymbol(member, name, kind);
        }
        info.members[kind] = names;
      } else if (key === 'modules' && depth < 4) {
        const modules = objectOf(value, this.root);
        for (const entry of modules?.namedChildren ?? []) {
          const name = keyOf(entry);
          const module = valueOf(entry);
          if (!name || !module) continue;
          const specifier = module.type === 'identifier' || module.type === 'shorthand_property_identifier' ? this.imports.get(module.text) : undefined;
          const inline = specifier === undefined ? objectOf(module, this.root) : null;
          if (specifier !== undefined) info.modules[name] = specifier;
          else if (inline) info.modules[name] = this.moduleInfo(inline, false, depth + 1);
        }
      }
    }
    return info;
  }

  /** `state: () => ({ … })`, `state() { return { … } }` or `state: { … }`. */
  private stateObject(value: Node): Node | null {
    const body = value.type === 'method_definition' || FUNCTION_VALUES.has(value.type) ? value.childForFieldName('body') : null;
    if (!body) return objectOf(value, this.root);
    if (body.type !== 'statement_block') return objectOf(body, this.root);
    const returned = body.namedChildren.find((s) => s.type === 'return_statement')?.namedChild(0) ?? null;
    return objectOf(returned, this.root);
  }

  /** Arrow-function members (`openTickets: (state) => …`) have no symbol from the generic extraction. */
  private memberSymbol(member: Node, name: string, kind: VuexKind): void {
    const startLine = member.startPosition.row + 1;
    if (this.result.symbols.some((s) => s.name === name && s.startLine === startLine)) return;
    this.result.symbols.push({ name, kind: 'method', scope: kind, signature: name, startLine, endLine: member.endPosition.row + 1, metadata: {} });
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  private call(node: Node): void {
    const callee = node.childForFieldName('function');
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];
    if (!callee) return;
    const pinia = this.piniaStore(callee.type === 'member_expression' ? callee.childForFieldName('object') : null, node);
    const property = callee.type === 'member_expression' ? callee.childForFieldName('property') : null;
    if (pinia && property?.type === 'property_identifier') {
      // store.action() / useXStore().action()
      this.target(property, property.text, pinia);
    } else if (callee.type === 'identifier' && this.isHook(callee.text)) {
      // useXStore()
      this.target(callee, callee.text, { store: 'pinia', hook: callee.text, specifier: this.imports.get(callee.text) ?? null });
    } else {
      const method = callee.type === 'identifier' ? callee.text : property?.text ?? '';
      const kind = CALL_KINDS[method];
      const path = stringValue(args[0]);
      if (!kind || !path) return;
      const receiver = callee.type === 'member_expression' ? callee.childForFieldName('object')?.text ?? '' : '';
      // this.$store.dispatch('ns/NAME'), store.commit('NAME'), or { root: true } in a module.
      const global = /(^|\.)\$?store$/.test(receiver) || path.includes('/') || /\broot\s*:\s*true\b/.test(args[2]?.text ?? '');
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      if (global) this.target(node, name, { store: 'vuex', kind, namespace: slash >= 0 ? path.slice(0, slash) : null });
      // dispatch('NAME') / commit('NAME') on the action context stays in this module.
      else if (this.model?.members[kind]?.includes(name)) this.target(node, name, { store: 'vuex', kind, namespace: null, local: true });
    }
  }

  private isHook(name: string): boolean {
    return PINIA_HOOK.test(name) && (this.imports.has(name) || this.localHooks.has(name));
  }

  /** The Pinia store an expression stands for: `useXStore()`, or a name bound to it in an enclosing scope. */
  private piniaStore(expression: Node | null, at: Node): VueStoreTarget | null {
    let hook: string | null = null;
    if (expression?.type === 'call_expression') {
      const fn = expression.childForFieldName('function');
      if (fn?.type === 'identifier' && this.isHook(fn.text)) hook = fn.text;
    } else if (expression?.type === 'identifier') {
      hook = this.boundHook(expression.text, at);
    }
    return hook ? { store: 'pinia', hook, specifier: this.imports.get(hook) ?? null } : null;
  }

  private boundHook(name: string, at: Node): string | null {
    for (let scope = at.parent; scope; scope = scope.parent) {
      if (scope.type !== 'statement_block' && scope.type !== 'program') continue;
      for (const top of scope.namedChildren) {
        const statement = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
        if (statement?.type !== 'lexical_declaration' && statement?.type !== 'variable_declaration') continue;
        for (const declarator of statement.namedChildren) {
          if (declarator.childForFieldName('name')?.text !== name) continue;
          let value = declarator.childForFieldName('value');
          if (value?.type === 'await_expression') value = value.namedChild(0);
          const fn = value?.type === 'call_expression' ? value.childForFieldName('function') : null;
          return fn?.type === 'identifier' && this.isHook(fn.text) ? fn.text : null;
        }
      }
    }
    return null;
  }

  /** Map-helper spreads in `methods` / `computed`: one reference per mapped name, from the component. */
  private mapHelpers(): void {
    for (const prop of this.options?.namedChildren ?? []) {
      const key = keyOf(prop);
      const value = valueOf(prop);
      if ((key !== 'methods' && key !== 'computed') || value?.type !== 'object') continue;
      for (const member of value.namedChildren) {
        if (member.type !== 'spread_element') continue;
        for (const entry of mapHelperEntries(member.namedChild(0), this.imports, this.localHooks)) {
          if (!entry.name || !entry.target) continue;
          this.result.references.push({
            sourceSymbol: this.component, targetName: entry.name, referenceType: 'call',
            startLine: member.startPosition.row + 1, verifiability: 'verified', vueStore: entry.target,
          });
        }
      }
    }
  }

  /**
   * Gives the call's existing name-only reference the store target, or adds one when the generic
   * extraction skipped it (`cart.clear()`: `clear` is a built-in method name). The owner follows
   * rule 2: the member's bare name, or the component for `<script setup>` / `setup()` code.
   */
  private target(at: Node, name: string, target: VueStoreTarget): void {
    // The generic extraction dates a reference by its name node.
    const startLine = at.startPosition.row + 1;
    const owner = this.owner(at);
    const existing = this.result.references.filter((r) => r.referenceType === 'call' && r.startLine === startLine && r.targetName === name && !r.vueThis && !r.vueStore);
    for (const ref of existing) {
      ref.vueStore = target;
      if (owner) ref.sourceSymbol = owner;
    }
    if (existing.length === 0) {
      const ref: ExtractedReference = { sourceSymbol: owner, targetName: name, referenceType: 'call', startLine, verifiability: 'verified', vueStore: target };
      this.result.references.push(ref);
    }
  }

  private owner(node: Node): string | null {
    for (let n = node.parent; n; n = n.parent) {
      if (n.type === 'method_definition') return this.memberOwner(n, n.childForFieldName('name')?.text ?? null);
      if (n.type === 'function_declaration' || n.type === 'generator_function_declaration') return n.childForFieldName('name')?.text ?? null;
      if (FUNCTION_VALUES.has(n.type)) {
        const holder = n.parent;
        if (holder?.type === 'pair') return this.memberOwner(holder, keyOf(holder));
        // `const f = () => …` at the top level is a function symbol; inside a body it is a local.
        if (holder?.type === 'variable_declarator' && topLevelDeclarator(this.root, holder.childForFieldName('name')?.text ?? '') === holder) {
          return holder.childForFieldName('name')!.text;
        }
      }
    }
    return this.component;
  }

  /** Code directly in the options object's `setup()` belongs to the component. */
  private memberOwner(member: Node, name: string | null): string | null {
    if (name === 'setup' && this.component && this.options && member.parent?.id === this.options.id) return this.component;
    return name;
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** The store member a `vueStore` reference names, or null (no edge). */
export function resolveStoreTarget(name: string, target: VueStoreTarget, ctx: VueResolveContext): VueTarget | null {
  if (target.store === 'pinia') {
    // Only the store's own file: never a same-named function elsewhere, nor the caller.
    const file = target.specifier === null ? ctx.sourceFile : ctx.resolveImport(target.specifier);
    return file && ctx.defines(file, name) ? { file, symbol: name } : null;
  }
  if (target.local) return { file: ctx.sourceFile, symbol: name };
  const files = ctx.vuexFiles();
  const has = (info: VuexModuleInfo) => info.members[target.kind]?.includes(name) ?? false;
  const child = (file: string, entry: string | VuexModuleInfo): { file: string; info: VuexModuleInfo } | null => {
    if (typeof entry !== 'string') return { file, info: entry };
    const childFile = ctx.resolveImport(entry, file);
    const info = childFile ? files.get(childFile) : undefined;
    return childFile && info ? { file: childFile, info } : null;
  };
  // Without a namespace: the root and the modules registered without `namespaced`.
  const global = (file: string, info: VuexModuleInfo, depth: number): string | null => {
    if (has(info)) return file;
    if (depth > 4) return null;
    for (const entry of Object.values(info.modules)) {
      const next = child(file, entry);
      const hit = next && !next.info.namespaced ? global(next.file, next.info, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  };
  // Nearest store root first: in a monorepo each app resolves against its own store.
  const shared = (file: string) => {
    const a = file.split('/'), b = ctx.sourceFile.split('/');
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    return i;
  };
  const roots = [...files].filter(([, info]) => info.root).sort(([a], [b]) => shared(b) - shared(a));
  for (const [rootFile, rootInfo] of roots) {
    if (target.namespace === null) {
      const hit = global(rootFile, rootInfo, 0);
      if (hit) return { file: hit, symbol: name };
      continue;
    }
    let current: { file: string; info: VuexModuleInfo } | null = { file: rootFile, info: rootInfo };
    for (const segment of target.namespace.split('/')) {
      const entry: string | VuexModuleInfo | undefined = current.info.modules[segment];
      current = entry === undefined ? null : child(current.file, entry);
      if (!current?.info.namespaced) break;
    }
    if (current?.info.namespaced && has(current.info)) return { file: current.file, symbol: name };
  }
  return null;
}

/** The phase's Vuex models: stored file metadata, replaced by this phase's parse results. */
export function collectVuexFiles(
  stored: Record<string, unknown>[], parsedPaths?: string[], results?: (ParseResult | undefined)[],
): Map<string, VuexModuleInfo> {
  const files = new Map<string, VuexModuleInfo>();
  for (const row of stored) {
    const metadata = row.metadata;
    if (typeof metadata !== 'string' || !metadata.includes('"vuex"')) continue;
    try {
      const vuex = JSON.parse(metadata).vuex as VuexModuleInfo | null;
      if (vuex) files.set(row.path as string, vuex);
    } catch {}
  }
  for (let i = 0; parsedPaths && results && i < parsedPaths.length; i++) {
    const res = results[i];
    if (!res) continue;
    files.delete(parsedPaths[i]);
    if (res.fileMetadata?.vuex) files.set(parsedPaths[i], res.fileMetadata.vuex as VuexModuleInfo);
  }
  return files;
}
