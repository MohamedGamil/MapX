/**
 * Lua method calls (M2-10). `function Account:withdraw(n)` declares the function `Account:withdraw`;
 * a call `self:log(n)` or `acct:withdraw(1)` names its receiver, not the table. When the file tells
 * the receiver's table, the call targets `T:m` (or `T.m` for `self.m()`) and records where T lives,
 * for the scanner (`resolveLuaMethodCall`):
 * - `local`: T is a local of this file (`local T = {}`), so only this file declares its methods;
 * - `global`: T is assigned without `local`, or not declared at all;
 * - `require`: T is bound by `require(…)`, resolved by its exact name as before M2-10.
 * Any other receiver (a parameter, a string, `io.open()`, `self.items`, an ambiguous local) keeps
 * the text as written and links nothing.
 *
 * Names resolve through the enclosing functions, innermost first, as Lua scopes them:
 * - `self` is T inside `function T:m()` or `function T.m(self, …)`; an inner function with its
 *   own `self` parameter is not T's method;
 * - a parameter is unknown;
 * - a name the function assigns is bound by every assignment there (`local x`, without a value,
 *   only declares it): `{…}` makes it a table, `T.new(…)`, `T:new(…)` and `setmetatable(…, T)`
 *   an instance of T, `require(…)` a module; a loop variable or any other value makes it unknown.
 */

export type LuaTableScope = 'local' | 'global' | 'require';

/** A Lua call target the receiver's table names, and where that table lives. */
export interface LuaCallTarget {
  targetName: string;
  luaTable: LuaTableScope;
}

/** What one assignment makes a name. `declare`: `local x` without a value. */
type Binding =
  | { kind: 'table' | 'require' | 'unknown' | 'declare'; local: boolean }
  | { kind: 'instance'; of: string; local: boolean };

/** What a name stands for at a call, and whether it is a local of the file or a global. */
type Resolved = { kind: 'table' | 'require'; scope: 'local' | 'global' } | { kind: 'instance'; of: string; scope: 'local' | 'global' } | null;

const FUNCTION_NODES = new Set(['function_definition_statement', 'local_function_definition_statement', 'function_definition']);
const BINDING_NODES = new Set(['local_variable_declaration', 'variable_assignment', 'for_generic_statement', 'for_numeric_statement']);

/** The name of `x` or of a `variable` naming `x`, else null. */
function simpleName(node: any): string | null {
  if (node?.type === 'identifier') return node.text;
  if (node?.type === 'variable' && !node.childForFieldName('table')) {
    const name = node.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : null;
  }
  return null;
}

/** What a value makes the name it is assigned to. */
function bindingOf(value: any, local: boolean): Binding {
  if (!value) return { kind: 'declare', local };
  if (value.type === 'table') return { kind: 'table', local };
  if (value.type !== 'call') return { kind: 'unknown', local };
  const fn = value.childForFieldName('function');
  const args = value.childForFieldName('arguments')?.namedChildren?.[0]?.namedChildren ?? [];
  const callee = simpleName(fn);
  if (callee === 'require') return { kind: 'require', local };
  if (callee === 'setmetatable' && args.length === 2) {
    // `setmetatable({}, Account)`: an Account; `setmetatable({}, { __index = Base })`: a table.
    const of = simpleName(args[1]);
    return of ? { kind: 'instance', of, local } : args[1]?.type === 'table' ? { kind: 'table', local } : { kind: 'unknown', local };
  }
  const member = fn?.type === 'variable' ? fn.childForFieldName('method') ?? fn.childForFieldName('field') : null;
  const of = member?.text === 'new' ? simpleName(fn.childForFieldName('table')) : null;
  return of ? { kind: 'instance', of, local } : { kind: 'unknown', local };
}

/** The bindings a function (or the chunk) makes itself, by name; nested functions are their own scopes. */
function scopeBindings(scope: any): Map<string, Binding[]> {
  const bindings = new Map<string, Binding[]>();
  const add = (name: string | null, binding: Binding) => {
    if (name) bindings.set(name, [...bindings.get(name) ?? [], binding]);
  };
  const cursor = scope.walk();
  // Walk the scope's subtree without entering nested functions, materialising only binding nodes.
  const visit = (): void => {
    if (!cursor.gotoFirstChild()) return;
    do {
      const type = cursor.nodeType;
      if (FUNCTION_NODES.has(type)) continue;
      if (BINDING_NODES.has(type)) {
        const node = cursor.currentNode;
        if (type === 'for_generic_statement' || type === 'for_numeric_statement') {
          const names = node.childForFieldName('left')?.namedChildren ?? [node.childForFieldName('name')];
          for (const n of names) add(simpleName(n), { kind: 'unknown', local: true });
        } else {
          const local = type === 'local_variable_declaration';
          const names = node.namedChildren.find((c: any) => c.type === 'variable_list')?.namedChildren ?? [];
          const values = node.namedChildren.find((c: any) => c.type === 'expression_list')?.namedChildren ?? [];
          names.forEach((n: any, i: number) => add(simpleName(n), bindingOf(values[i], local)));
        }
      }
      visit();
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  };
  visit();
  cursor.delete?.();
  return bindings;
}

/** The function nodes enclosing `node`, innermost first, then the chunk. */
function enclosingScopes(node: any): any[] {
  const scopes: any[] = [];
  for (let curr = node.parent; curr; curr = curr.parent) {
    if (FUNCTION_NODES.has(curr.type) || !curr.parent) scopes.push(curr);
  }
  return scopes;
}

/** Per parse: the bindings of each scope, computed once (keyed by node id). */
export class LuaScopes {
  private bindings = new Map<number, Map<string, Binding[]>>();

  private bindingsOf(scope: any): Map<string, Binding[]> {
    let b = this.bindings.get(scope.id);
    if (!b) this.bindings.set(scope.id, (b = scopeBindings(scope)));
    return b;
  }

  /** What `name` stands for at `node`. */
  resolve(name: string, node: any): Resolved {
    const scopes = enclosingScopes(node);
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i];
      if (scope.type !== 'chunk' && FUNCTION_NODES.has(scope.type)) {
        const params = scope.childForFieldName('parameters')?.namedChildren ?? [];
        const owner = scope.type === 'function_definition_statement' ? scope.childForFieldName('name') : null;
        const table = owner?.type === 'variable' ? owner.childForFieldName('table') : null;
        const tableName = table ? simpleName(table) ?? table.text : null;
        // `function T:m()` binds self implicitly; `function T.m(self)` explicitly.
        if (name === 'self' && tableName && owner.childForFieldName('method')) return { kind: 'instance', of: tableName, scope: 'local' };
        if (params.some((p: any) => p.type === 'identifier' && p.text === name)) {
          return name === 'self' && tableName && params[0]?.text === 'self' ? { kind: 'instance', of: tableName, scope: 'local' } : null;
        }
      }
      const bound = this.bindingsOf(scope).get(name);
      if (!bound) continue;
      const assigned = bound.filter((b) => b.kind !== 'declare');
      const first = assigned[0];
      if (!first || assigned.some((b) => b.kind !== first.kind || (b.kind === 'instance' && first.kind === 'instance' && b.of !== first.of))) return null;
      if (first.kind === 'unknown') return null;
      // Local when this scope, or one around it, declares the name local.
      const where = bound.some((b) => b.local) || scopes.slice(i + 1).some((s) => this.bindingsOf(s).get(name)?.some((b) => b.local)) ? 'local' : 'global';
      return first.kind === 'instance' ? { kind: 'instance', of: first.of, scope: where } : { kind: first.kind as 'table' | 'require', scope: where };
    }
    // Declared nowhere in the file: a global table.
    return { kind: 'table', scope: 'global' };
  }

  /** The table `name` is, or is an instance of, at `node`, and where that table lives. */
  tableOf(name: string, node: any): { table: string; scope: LuaTableScope } | null {
    const r = this.resolve(name, node);
    if (r?.kind !== 'instance') return r ? { table: name, scope: r.kind === 'require' ? 'require' : r.scope } : null;
    // An instance of T. T may itself be made by `setmetatable({}, Base)`: its methods are still T's.
    const of = this.resolve(r.of, node);
    return of ? { table: r.of, scope: of.kind === 'require' ? 'require' : of.scope } : null;
  }
}

/**
 * The target of a call whose function is `variable` (`self:log`, `acct:withdraw`): `T:m` with its
 * table's scope when the receiver's table is known; for `self.m()`, `T.m` without a scope (it
 * resolves as any dotted name). Null keeps the call as written: a `:` call without a scope links
 * nothing.
 */
export function luaCallTarget(variable: any, scopes: () => LuaScopes): LuaCallTarget | { targetName: string } | null {
  if (variable?.type !== 'variable' || variable.parent?.type !== 'call') return null;
  const method = variable.childForFieldName('method');
  const member = method ?? variable.childForFieldName('field');
  const receiver = simpleName(variable.childForFieldName('table'));
  if (!member || !receiver || (!method && receiver !== 'self')) return null;
  const t = scopes().tableOf(receiver, variable);
  if (!t) return null;
  return method ? { targetName: `${t.table}:${member.text}`, luaTable: t.scope } : { targetName: `${t.table}.${member.text}` };
}
