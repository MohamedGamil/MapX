// Evaluates frontend request URLs (docs/baton M2-04, M2-05; contract D008): string literals,
// concatenation, template literals and string constants (M2-04), joined to the client's base URL
// read from literals, constants or .env files with axios semantics (M2-05). Unknown parts → {}.
import { posix } from 'node:path';
import { resolveImport } from './client-calls.js';

const QUOTED = /^(['"])((?:\\.|(?!\1).)*)\1$/s;
const TEMPLATE = /^`((?:\\.|[^`])*)`$/s;

/** String constants of one file: `const X = '…'` (also exported, and template literals without substitutions). */
export function fileConstants(content: string): Map<string, string> {
  const constants = new Map<string, string>();
  const literal = `(['"\`])((?:\\\\.|(?!\\LQ).)*)\\LQ(?!\\s*[+.[(?*\\/%-])`;
  const add = (name: string, quote: string, body: string) => {
    if (quote !== '`' || !body.includes('${')) constants.set(name, body.replace(/\\(.)/g, '$1'));
  };
  // The literal must be the whole initialiser: `'/api' + VERSION` or `'v1'.toUpperCase()` is not a constant.
  const first = new RegExp(`(?:export\\s+)?const\\s+(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${literal.replace(/LQ/g, '2')}`, 'gs');
  const next = new RegExp(`^\\s*,\\s*(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${literal.replace(/LQ/g, '2')}`, 's');
  for (const m of content.matchAll(first)) {
    add(m[1]!, m[2]!, m[3]!);
    // Further declarators of the same statement: const A = '/a', B = '/b';
    let rest = content.slice(m.index! + m[0].length);
    for (let d = next.exec(rest); d; d = next.exec(rest)) {
      add(d[1]!, d[2]!, d[3]!);
      rest = rest.slice(d[0].length);
    }
  }
  return constants;
}

export interface ConstantIndex {
  /** file → its own constants (exported or not). */
  byFile: Map<string, Map<string, string>>;
  /** file → names it exports. */
  exported: Map<string, Set<string>>;
}

export function collectConstants(files: { path: string; content: string }[]): ConstantIndex {
  const index: ConstantIndex = { byFile: new Map(), exported: new Map() };
  for (const { path, content } of files) {
    index.byFile.set(path, fileConstants(content));
    index.exported.set(path, new Set([...content.matchAll(/export\s+const\s+(\w+)/g)].map((m) => m[1]!)));
  }
  return index;
}

/** Constants visible in `file`: its own plus named imports of exported constants. */
export function visibleConstants(file: string, content: string, index: ConstantIndex, files: Set<string>): Map<string, string> {
  const visible = new Map(index.byFile.get(file) ?? []);
  for (const m of content.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveImport(file, m[2]!, files);
    if (!target) continue;
    for (const item of m[1]!.split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/);
      const value = imported && index.exported.get(target)?.has(imported) ? index.byFile.get(target)?.get(imported) : undefined;
      if (value !== undefined) visible.set(local ?? imported!, value);
    }
  }
  return visible;
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

/** Parses a dotenv file: KEY=value lines, optional quotes, # comments. */
export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    vars.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, ''));
  }
  return vars;
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
