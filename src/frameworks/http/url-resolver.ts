// Evaluates frontend request URLs (docs/baton M2-04, M2-05; contract D008): string literals,
// concatenation, template literals and string constants (M2-04), joined to the client's base URL
// read from literals, constants or .env files with axios semantics (M2-05). Unknown parts → {}.
import { posix } from 'node:path';
import { maskSource, resolveImport, type ReadText } from './client-calls.js';

const QUOTED = /^(['"])((?:\\.|(?!\1).)*)\1$/s;
const TEMPLATE = /^`((?:\\.|[^`])*)`$/s;

/**
 * A name bound in a file and the source range it is visible in (M2-04-R2): `const`/`let`/`var`
 * declarations and function parameters. Only a `const` whose whole initialiser is a string
 * literal has a `value`; any other binding hides outer constants of the same name.
 */
export interface Binding {
  name: string;
  value?: string;
  start: number;
  end: number;
}

/** Literal `const` values by the offset of their `const` keyword: `const A = '/a', B = '/b'`. */
function literalConstants(content: string): Map<number, Map<string, string>> {
  const byStatement = new Map<number, Map<string, string>>();
  const literal = `(['"\`])((?:\\\\.|(?!\\LQ).)*)\\LQ(?!\\s*[+.[(?*\\/%-])`;
  // The literal must be the whole initialiser: `'/api' + VERSION` or `'v1'.toUpperCase()` is not a constant.
  const first = new RegExp(`\\bconst\\s+(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${literal.replace(/LQ/g, '2')}`, 'gs');
  const next = new RegExp(`^\\s*,\\s*(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${literal.replace(/LQ/g, '2')}`, 's');
  for (const m of content.matchAll(first)) {
    const values = new Map<string, string>();
    const add = (name: string, quote: string, body: string) => {
      if (quote !== '`' || !body.includes('${')) values.set(name, body.replace(/\\(.)/g, '$1'));
    };
    add(m[1]!, m[2]!, m[3]!);
    // Further declarators of the same statement
    let rest = content.slice(m.index! + m[0].length);
    for (let d = next.exec(rest); d; d = next.exec(rest)) {
      add(d[1]!, d[2]!, d[3]!);
      rest = rest.slice(d[0].length);
    }
    byStatement.set(m.index!, values);
  }
  return byStatement;
}

/** Names bound by a parameter list or a destructuring pattern (masked source). */
function boundNames(list: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  const take = (item: string) => {
    const param = item.trim().replace(/^\.\.\./, '');
    if (/^[{[]/.test(param)) {
      // { a, b: c, d = 1 } binds a, c and d; over-collecting only hides more constants.
      for (const m of param.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$]|\s*:)/g)) names.push(m[1]!);
    } else {
      const m = param.match(/^(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/);
      if (m) names.push(m[1]!);
    }
  };
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && !(c === '>' && list[i - 1] === '=')) depth--;
    else if (c === ',' && depth === 0) {
      take(list.slice(start, i));
      start = i + 1;
    }
  }
  take(list.slice(start));
  return names;
}

/** Parameters of the function whose body or arrow follows `head` (masked text before `{` or `=>`). */
function paramsBefore(head: string, arrow: boolean): string[] {
  let text = head.trimEnd().replace(/\)\s*:\s*[^(){};=]*$/, ')');
  if (arrow) {
    text = text.replace(/=>$/, '').trimEnd().replace(/\)\s*:\s*[^(){};=]*$/, ')');
    const single = text.match(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/);
    if (single && !text.endsWith(')')) return single[1] === 'async' ? [] : [single[1]!];
  }
  if (!text.endsWith(')')) return [];
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) {
      // `if (x) {` and friends are not functions; `catch (e) {` binds e.
      if (!arrow && /(?:^|[^\w$.])(?:if|for|while|switch|with)\s*$/.test(text.slice(0, i))) return [];
      return boundNames(text.slice(i + 1, -1));
    }
  }
  return [];
}

/**
 * Every binding of one file with the range it is visible in: the innermost `{…}` block around a
 * declaration (the whole file at top level), a function body for its parameters, and the body
 * expression of a brace-less arrow. Declarations inside comments, strings and SFC templates do not
 * count.
 */
export function fileBindings(file: string, content: string): Binding[] {
  const masked = maskSource(file, content);
  const values = literalConstants(content);
  const declarations = [...masked.matchAll(/(?<![\w$.])(const|let|var)\s+(?:([A-Za-z_$][\w$]*)|([{[]))/g)];
  // One pass over the braces: the enclosing block of each declaration, and where each block ends.
  const queries = declarations.map((m) => m.index!);
  const enclosing = new Map<number, number>();
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0, q = 0; i <= masked.length; i++) {
    for (; q < queries.length && queries[q] === i; q++) enclosing.set(i, stack[stack.length - 1] ?? -1);
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}' && stack.length) closeOf.set(stack.pop()!, i);
  }
  const scope = (open: number): [number, number] => (open < 0 ? [0, content.length] : [open, closeOf.get(open) ?? content.length]);
  const bindings: Binding[] = [];
  for (const m of declarations) {
    const [start, end] = scope(enclosing.get(m.index!)!);
    const statement = m[1] === 'const' ? values.get(m.index!) : undefined;
    if (m[2]) bindings.push({ name: m[2], value: statement?.get(m[2]), start, end });
    else {
      const open = m.index! + m[0].length - 1;
      for (const name of boundNames(masked.slice(open + 1, matchClose(masked, open)))) bindings.push({ name, start, end });
    }
    for (const [name, value] of statement ?? []) if (name !== m[2]) bindings.push({ name, value, start, end });
  }
  // Parameters: of block-bodied functions and methods, and of brace-less arrows.
  for (const [open, close] of closeOf) {
    const head = masked.slice(Math.max(0, open - 400), open);
    for (const name of paramsBefore(head, /=>\s*$/.test(head))) bindings.push({ name, start: open, end: close });
  }
  for (const m of masked.matchAll(/=>(?!\s*\{)/g)) {
    const params = paramsBefore(masked.slice(Math.max(0, m.index! - 400), m.index! + 2), true);
    if (!params.length) continue;
    let depth = 0;
    let end = m.index! + 2;
    for (; end < masked.length; end++) {
      const c = masked[end]!;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c) && --depth < 0) break;
      else if ((c === ',' || c === ';') && depth === 0) break;
    }
    for (const name of params) bindings.push({ name, start: m.index!, end });
  }
  return bindings;
}

function matchClose(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if ('([{'.includes(masked[i]!)) depth++;
    else if (')]}'.includes(masked[i]!) && --depth === 0) return i;
  }
  return masked.length;
}

/**
 * Constants visible at `offset` (top level when omitted): `outer` (imported constants) overridden
 * by the innermost bindings around the offset. A name whose innermost binding has no value, or
 * whose bindings of that scope disagree, is not a constant there.
 */
export function constantsAt(bindings: Binding[], offset: number | undefined, outer: Map<string, string> = new Map()): Map<string, string> {
  const at = offset ?? 0;
  const innermost = new Map<string, Binding[]>();
  for (const b of bindings) {
    if (offset === undefined ? b.start !== 0 : at < b.start || at > b.end) continue;
    const best = innermost.get(b.name);
    const size = b.end - b.start;
    if (!best || size < best[0]!.end - best[0]!.start) innermost.set(b.name, [b]);
    else if (size === best[0]!.end - best[0]!.start) best.push(b);
  }
  const visible = new Map(outer);
  for (const [name, group] of innermost) {
    const value = group[0]!.value;
    if (value !== undefined && group.every((b) => b.value === value)) visible.set(name, value);
    else visible.delete(name);
  }
  return visible;
}

/**
 * Constants for an expression whose position is unknown (a client's `baseURL`): those visible at
 * top level, plus names that every binding in the file gives the same value, wherever declared.
 */
export function constantsAnywhere(bindings: Binding[], outer: Map<string, string> = new Map()): Map<string, string> {
  const visible = constantsAt(bindings, undefined, outer);
  const values = new Map<string, string | undefined>();
  for (const b of bindings) values.set(b.name, values.has(b.name) && values.get(b.name) !== b.value ? undefined : b.value);
  for (const [name, value] of values) if (value !== undefined && !visible.has(name)) visible.set(name, value);
  return visible;
}

/** Top-level string constants of one file: `const X = '…'` (also exported, and template literals without substitutions). */
export function fileConstants(content: string, file = 'module.js'): Map<string, string> {
  return constantsAt(fileBindings(file, content), undefined);
}

export interface ConstantIndex {
  /** file → its own top-level constants (exported or not). */
  byFile: Map<string, Map<string, string>>;
  /** file → names it exports. */
  exported: Map<string, Set<string>>;
  /** file → every binding with its scope, for lookups at a call site. */
  bindings: Map<string, Binding[]>;
}

export function collectConstants(files: { path: string; content: string }[]): ConstantIndex {
  const index: ConstantIndex = { byFile: new Map(), exported: new Map(), bindings: new Map() };
  for (const { path, content } of files) {
    const bindings = fileBindings(path, content);
    index.bindings.set(path, bindings);
    index.byFile.set(path, constantsAt(bindings, undefined));
    index.exported.set(path, new Set([...content.matchAll(/export\s+const\s+(\w+)/g)].map((m) => m[1]!)));
  }
  return index;
}

/** Named imports of exported constants into `file`. */
export function importedConstants(file: string, content: string, index: ConstantIndex, files: Set<string>, readText?: ReadText): Map<string, string> {
  const imported = new Map<string, string>();
  for (const m of content.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveImport(file, m[2]!, files, readText);
    if (!target) continue;
    for (const item of m[1]!.split(',')) {
      const [name, local] = item.trim().split(/\s+as\s+/);
      const value = name && index.exported.get(target)?.has(name) ? index.byFile.get(target)?.get(name) : undefined;
      if (value !== undefined) imported.set(local ?? name!, value);
    }
  }
  return imported;
}

/**
 * Constants visible in `file` at `offset` (top level when omitted): named imports of exported
 * constants, shadowed by the file's own bindings in scope there.
 */
export function visibleConstants(file: string, content: string, index: ConstantIndex, files: Set<string>, offset?: number, readText?: ReadText): Map<string, string> {
  return constantsAt(index.bindings.get(file) ?? [], offset, importedConstants(file, content, index, files, readText));
}

function balancedParens(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Splits on top-level `+`, respecting strings, templates and brackets. */
function splitPlus(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  // `${…}` nesting inside the current template, separate from bracket depth
  let interpolation = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (quote === '`' && c === '$' && expr[i + 1] === '{') interpolation++;
      else if (quote === '`' && c === '}' && interpolation > 0) interpolation--;
      else if (c === quote && interpolation === 0) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '+' && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

export interface Evaluated {
  value: string;
  /** True when at least one part was a literal or known constant. */
  known: boolean;
}

/**
 * Evaluates a JS string expression. Literals and known constants contribute their text; any
 * other part becomes `{}` (a path parameter). `env` resolves process.env / import.meta.env keys.
 */
export function evaluate(expr: string, constants: Map<string, string>, env: (key: string) => string | undefined = () => undefined): Evaluated {
  let value = '';
  let known = false;
  for (let part of splitPlus(expr.trim())) {
    let m: RegExpMatchArray | null;
    // ('/api/' + id): evaluate the parenthesised expression as a part
    while (part.startsWith('(') && part.endsWith(')') && balancedParens(part.slice(1, -1))) part = part.slice(1, -1).trim();
    if (/^\(|\+/.test(part) && splitPlus(part).length > 1) {
      const inner = evaluate(part, constants, env);
      value += inner.known ? inner.value : '{}';
      known ||= inner.known;
      continue;
    }
    if ((m = part.match(QUOTED))) {
      value += m[2]!.replace(/\\(.)/g, '$1');
      known = true;
    } else if ((m = part.match(TEMPLATE)) || (part.startsWith('`') && part.endsWith('`') && part.length > 1)) {
      // Nested templates inside ${…} contain backticks, so take the body by position.
      const body = m ? m[1]! : part.slice(1, -1);
      let i = 0;
      while (i < body.length) {
        if (body[i] === '$' && body[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < body.length && depth) {
            if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
            j++;
          }
          const inner = evaluate(body.slice(i + 2, j - 1), constants, env);
          value += inner.known ? inner.value : '{}';
          known ||= inner.known;
          i = j;
        } else {
          value += body[i] === '\\' ? body[++i] ?? '' : body[i];
          known = true;
          i++;
        }
      }
    } else if ((m = part.match(/^(?:process\.env|import\.meta\.env)\.(\w+)$/))) {
      const v = env(m[1]!);
      if (v === undefined) value += '{}';
      else {
        value += v;
        known = true;
      }
    } else if (/^[A-Za-z_$][\w$]*$/.test(part) && constants.has(part)) {
      value += constants.get(part)!;
      known = true;
    } else {
      value += '{}';
    }
  }
  return { value, known };
}

/** axios combineURLs: an absolute URL wins; otherwise one `/` between base and path. */
export function joinURL(base: string | undefined, path: string): string {
  if (!base || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return path;
  return path ? `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` : base;
}

/**
 * Parses a dotenv file as Vite does (dotenv 16, Node's `parseEnv`): a quoted value is what lies
 * between its quotes, whatever follows (`KEY="/api" # c` → `/api`), and may span lines; `\n` in
 * double quotes is a newline; an unquoted value ends at `#`.
 */
export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  const line = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;
  for (const m of text.replace(/\r\n?/g, '\n').matchAll(line)) {
    let value = (m[2] ?? '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/, '$2');
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    vars.set(m[1]!, value);
  }
  return vars;
}

/**
 * Expands `${VAR}`, `$VAR`, `${VAR:-default}`, `${VAR-default}` and `${VAR:+alt}` in a dotenv value
 * as Vite does (dotenv-expand), looking variables up with `lookup` (the env files of the source
 * file); `\$` is a literal `$`. A variable no env file defines would come from the build
 * environment (Vite substitutes `''`), so the value is then unknown: undefined. `key` is the
 * variable being expanded, so that a self-reference expands like a cycle (to its default).
 */
export function expandDotenv(value: string, lookup: (key: string) => string | undefined, key?: string): string | undefined {
  const expand = (text: string, seen: Set<string>): string | undefined => {
    let unknown = false;
    const out = text.replace(/(?<!\\)\$\{([^{}]+)\}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced?: string, bare?: string) => {
      const expression = (braced ?? bare)!;
      const op = expression.match(/:\+|\+|:-|-/)?.[0];
      const [name, ...rest] = op ? expression.split(op) : [expression];
      const alternative = rest.join(op);
      const raw = seen.has(name!) ? '' : lookup(name!);
      const set = raw === undefined ? undefined : expand(raw, new Set(seen).add(name!));
      let result: string | undefined;
      if (op === ':+' || op === '+') result = raw === undefined ? undefined : raw ? expand(alternative, seen) : '';
      else if (set) result = set;
      else if (raw === undefined ? !op : set === undefined) result = undefined;
      else result = expand(alternative, seen);
      if (result === undefined) unknown = true;
      return result ?? '';
    });
    return unknown ? undefined : out;
  };
  return expand(value, new Set(key ? [key] : []))?.replace(/\\\$/g, '$');
}

/**
 * Env files consulted for a source file, nearest directory first; within a directory in Vite /
 * Vue CLI precedence for development (`.env.development.local` > `.env.development` >
 * `.env.local` > `.env`), with `.env.production` as a last resort. Stops at `root`.
 */
export function envCandidates(file: string, root = ''): string[] {
  const names = ['.env.development.local', '.env.development', '.env.local', '.env', '.env.production'];
  const out: string[] = [];
  const stop = root.replace(/\/+$/, '');
  let dir = posix.dirname(file);
  for (;;) {
    const d = dir === '.' || dir === '/' ? (dir === '/' ? '/' : '') : dir;
    for (const n of names) out.push(d ? posix.join(d, n) : n);
    const parent = posix.dirname(dir);
    if (!d || d === '/' || d === stop || parent === dir) break;
    dir = parent;
  }
  return out;
}
