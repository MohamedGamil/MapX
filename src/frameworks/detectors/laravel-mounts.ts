// Laravel route-mount helpers: PHP string evaluation, resource singularisation and app-root
// discovery. Pure functions plus a bounded directory walk; no parsing state lives here.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface PhpScope {
  /** Directory of the file being evaluated, workspace-relative ('' for the root). */
  dir: string;
  /** Laravel application root, workspace-relative ('' for the root). */
  root: string;
  /** Local string variables visible at the evaluated position. */
  vars: Map<string, string>;
}

const QUOTED = /^(['"])((?:\\.|(?!\1).)*)\1$/s;

/**
 * Same-length views of a PHP file for structural scanning. `text` blanks comments (`//`, `#`,
 * `/* *\/`) and inline HTML; `code` also blanks the contents of strings, heredocs and nowdocs,
 * keeping their delimiters. Newlines are kept, so offsets and line numbers match the source.
 */
export function maskPhp(src: string): { code: string; text: string } {
  const code = src.split('');
  const text = src.split('');
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
  };
  // A file with no open tag is read as plain PHP (snippets, tests).
  let php = !/<\?(?:php\b|=)/.test(src);
  let i = 0;
  while (i < src.length) {
    if (!php) {
      const open = src.slice(i).search(/<\?(?:php\b|=)?/);
      const end = open < 0 ? src.length : i + open;
      blank(code, i, end);
      blank(text, i, end);
      if (open < 0) break;
      php = true;
      i = end + (src.startsWith('<?php', end) ? 5 : src.startsWith('<?=', end) ? 3 : 2);
      continue;
    }
    const c = src[i]!;
    if (c === '?' && src[i + 1] === '>') {
      php = false;
      i += 2;
    } else if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      // A line comment also ends at `?>`.
      let end = i;
      while (end < src.length && src[end] !== '\n' && !(src[end] === '?' && src[end + 1] === '>')) end++;
      blank(code, i, end);
      blank(text, i, end);
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(code, i, end);
      blank(text, i, end);
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === '\\' ? 2 : 1;
      blank(code, i + 1, Math.min(end, src.length));
      i = end + 1;
    } else if (c === '<' && src.startsWith('<<<', i)) {
      const head = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 200));
      if (!head) {
        i += 3;
        continue;
      }
      // PHP 7.3+: the closing marker may be indented and followed by any non-identifier char.
      const closing = new RegExp(`^[ \\t]*${head[2]}\\b`, 'gm');
      closing.lastIndex = i + head[0].length;
      const m = closing.exec(src);
      const end = m ? m.index + m[0].length : src.length;
      blank(code, i + 3, end);
      i = end;
    } else {
      i++;
    }
  }
  return { code: code.join(''), text: text.join('') };
}

/**
 * Evaluates a double-quoted string body: escapes plus `$v`, `{$v}` and `${v}` from local variables.
 * An unresolvable interpolation gives null, or `fallback` in its place when one is given.
 */
function interpolate(body: string, vars: Map<string, string>, fallback?: string): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\') {
      const n = body[i + 1] ?? '';
      out += /["\\$]/.test(n) ? n : c + n;
      i++;
      continue;
    }
    const rest = body.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\{\$(\w+)\}/)) || (m = rest.match(/^\$\{(\w+)\}/))) {
      const value = vars.get(m[1]!) ?? fallback;
      if (value === undefined) return null;
      out += value;
      i += m[0].length - 1;
    } else if (rest.startsWith('{$') || rest.startsWith('${')) {
      // Complex expression: up to the matching brace.
      if (fallback === undefined) return null;
      let depth = 0;
      let j = i + (rest.startsWith('{') ? 0 : 1);
      for (; j < body.length; j++) if (body[j] === '{') depth++; else if (body[j] === '}' && --depth === 0) break;
      out += fallback;
      i = j;
    } else if ((m = rest.match(/^\$([A-Za-z_]\w*)((?:->\w+|\[[^\]]*\])*)/))) {
      // Array or property access is never resolved.
      const value = m[2] ? fallback : vars.get(m[1]!) ?? fallback;
      if (value === undefined) return null;
      out += value;
      i += m[0].length - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** Splits a PHP expression on top-level `.` concatenation operators. */
function splitConcat(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      current += c;
      if (c === '\\') current += expr[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    // A `.` between digits is a decimal point, not concatenation.
    else if (c === '.' && depth === 0 && !/\d/.test(expr[i + 1] ?? '')) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current.trim());
  return parts;
}

/** Splits a PHP argument list on top-level commas (strings and brackets respected). */
function splitArgs(expr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      current += c;
      if (c === '\\') current += expr[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** nwidart/laravel-modules' default `config('modules.paths.modules')`, relative to the app root. */
const MODULES_DIR = 'Modules';

const PATH_HELPERS: Record<string, string> = {
  base_path: '',
  app_path: 'app',
  config_path: 'config',
  database_path: 'database',
  resource_path: 'resources',
};

/**
 * Evaluates a PHP string expression made of literals, local variables (and `$this->prop`, read
 * from the class's string property declarations), interpolation, `__DIR__`, `dirname(__DIR__)`,
 * `DIRECTORY_SEPARATOR`, Laravel path helpers and nwidart's `module_path(name, path)`.
 * Path-like results are workspace-relative.
 * When any part is dynamic, returns null, or puts `fallback` in that part's place when one is
 * given (so `SOME_CONST.'/x'` gives `{dynamic}/x` with fallback `{dynamic}`).
 */
export function phpString(expr: string, scope: PhpScope, fallback?: string): string | null {
  const parts = splitConcat(expr.trim());
  let out = '';
  for (const part of parts) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(QUOTED))) {
      const value = m[1] === '"' ? interpolate(m[2]!, scope.vars, fallback) : m[2]!.replace(/\\(['\\])/g, '$1');
      if (value === null) return null;
      out += value;
    } else if (part === '__DIR__') {
      out += scope.dir;
    } else if (part === 'DIRECTORY_SEPARATOR') {
      out += '/';
    } else if ((m = part.match(/^dirname\s*\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\)$/))) {
      let dir = scope.dir;
      for (let i = 0; i < Number(m[1] ?? 1); i++) dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
      out += dir;
    } else if ((m = part.match(/^\$(?:this\s*->\s*)?(\w+)$/))) {
      const value = scope.vars.get(m[1]!) ?? fallback;
      if (value === undefined) return null;
      out += value;
    } else if ((m = part.match(/^module_path\s*\(\s*(.*?)\s*\)$/s))) {
      const [nameExpr, pathExpr] = splitArgs(m[1]!);
      const name = nameExpr ? phpString(nameExpr, scope) : null;
      const inner = pathExpr ? phpString(pathExpr, scope) : '';
      if ((name === null || inner === null) && fallback === undefined) return null;
      out += name === null || inner === null ? fallback : posix.join(scope.root, MODULES_DIR, name, inner);
    } else if ((m = part.match(/^(\w+)\s*\(\s*(.*?)\s*\)$/s)) && m[1]! in PATH_HELPERS) {
      const inner = m[2] ? phpString(m[2], scope) : '';
      if (inner === null && fallback === undefined) return null;
      out += inner === null ? fallback : posix.join(scope.root, PATH_HELPERS[m[1]!]!, inner);
    } else if (fallback !== undefined) {
      out += fallback;
    } else {
      return null;
    }
  }
  if (fallback) while (out.includes(fallback + fallback)) out = out.split(fallback + fallback).join(fallback);
  return out;
}

/** Normalises a path built from `__DIR__` etc. into a workspace-relative POSIX path. */
export function normalizeMountPath(path: string): string {
  const joined = posix.normalize(path.replace(/\\/g, '/'));
  return joined.replace(/^\.\/?/, '').replace(/^\/+/, '');
}

/**
 * Collects `$name = 'literal';` assignments with their offsets, for position-aware lookup.
 * With `code` (see maskPhp), matches that start inside a string are ignored.
 */
export function stringAssignments(content: string, code?: string): { name: string; value: string; index: number }[] {
  const result: { name: string; value: string; index: number }[] = [];
  const re = /\$(\w+)\s*=\s*((['"])(?:\\.|(?!\3).)*\3)\s*;/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (code && code[m.index] !== '$') continue;
    const quoted = m[2]!.match(QUOTED);
    if (quoted && !(quoted[1] === '"' && /\$\w/.test(quoted[2]!)))
      result.push({ name: m[1]!, value: quoted[2]!, index: m.index });
  }
  return result;
}

export function varsAt(assignments: { name: string; value: string; index: number }[], index: number): Map<string, string> {
  const vars = new Map<string, string>();
  for (const a of assignments) if (a.index < index) vars.set(a.name, a.value);
  return vars;
}

/** Index just past the bracket that closes the one at `open` in masked code, or -1. */
export function closingBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/**
 * Masked views of a service provider (see maskPhp) with the bodies of methods Laravel never runs
 * blanked: a method counts only when it is reachable from `boot`, `map` or `register` through
 * `$this->`, `self::` or `static::` calls. Applied only to classes extending an Illuminate provider,
 * whose base class calls nothing else of ours.
 */
export function liveProviderCode(src: string): { code: string; text: string } {
  const { code, text } = maskPhp(src);
  const ext = /\bclass\s+\w+\s+extends\s+\\?([\w\\]+)/.exec(code);
  if (!ext) return { code, text };
  const base = ext[1]!;
  const alias = base.split('\\').pop()!;
  const imported = new RegExp(`\\buse\\s+\\\\?([\\w\\\\]+?)(?:\\s+as\\s+(\\w+))?\\s*;`, 'g');
  let fqn = base.includes('\\') ? base : '';
  for (const m of text.matchAll(imported)) if ((m[2] ?? m[1]!.split('\\').pop()) === alias) fqn = m[1]!;
  if (!fqn.startsWith('Illuminate\\')) return { code, text };

  const methods = new Map<string, { start: number; end: number; calls: string[] }>();
  for (const m of code.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const params = closingBracket(code, m.index! + m[0].length - 1);
    if (params < 0) continue;
    const brace = code.slice(params).search(/[{;]/);
    if (brace < 0 || code[params + brace] !== '{') continue; // abstract or interface method
    const start = params + brace;
    const end = closingBracket(code, start);
    if (end < 0) continue;
    const calls = [...code.slice(start, end).matchAll(/(?:\$this\s*->\s*|\bself::|\bstatic::)(\w+)\s*\(/g)].map(c => c[1]!);
    methods.set(m[1]!, { start, end, calls });
  }
  const live = new Set<string>();
  const queue = ['boot', 'map', 'register'].filter(n => methods.has(n));
  if (!queue.length) return { code, text };
  while (queue.length) {
    const name = queue.shift()!;
    if (live.has(name)) continue;
    live.add(name);
    queue.push(...methods.get(name)!.calls.filter(c => methods.has(c)));
  }
  const blankRange = (s: string, from: number, to: number) => s.slice(0, from) + s.slice(from, to).replace(/[^\r\n]/g, ' ') + s.slice(to);
  let liveCode = code;
  let liveText = text;
  for (const [name, m] of methods) {
    if (live.has(name)) continue;
    liveCode = blankRange(liveCode, m.start + 1, m.end - 1);
    liveText = blankRange(liveText, m.start + 1, m.end - 1);
  }
  return { code: liveCode, text: liveText };
}

// Irregular and uncountable words, following Laravel's Pluralizer (doctrine/inflector) for the
// cases that occur in resource names.
const IRREGULAR: Record<string, string> = {
  people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose',
  teeth: 'tooth', feet: 'foot', oxen: 'ox', criteria: 'criterion', phenomena: 'phenomenon',
  indices: 'index', matrices: 'matrix', vertices: 'vertex', analyses: 'analysis', crises: 'crisis',
  theses: 'thesis', axes: 'axis', movies: 'movie', cookies: 'cookie', quizzes: 'quiz',
  leaves: 'leaf', lives: 'life', knives: 'knife', wives: 'wife', wolves: 'wolf', halves: 'half',
  shelves: 'shelf', thieves: 'thief', loaves: 'loaf', calves: 'calf', selves: 'self',
};
const UNCOUNTABLE = new Set([
  'audio', 'data', 'equipment', 'feedback', 'fish', 'information', 'metadata', 'money', 'news',
  'police', 'rice', 'series', 'sheep', 'species', 'traffic', 'deer', 'moose', 'staff', 'software',
  'hardware', 'knowledge', 'evidence', 'advice', 'luggage', 'furniture', 'education', 'cattle',
]);

function singularWord(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  const keepCase = (s: string) => (word[0] === word[0]!.toUpperCase() ? s[0]!.toUpperCase() + s.slice(1) : s);
  if (IRREGULAR[lower]) return keepCase(IRREGULAR[lower]!);
  const rules: [RegExp, string][] = [
    [/(quiz)zes$/i, '$1'],
    [/(matr|vert|ind)ices$/i, '$1ix'],
    [/(alias|status|campus|bus|virus|census|bonus|octopus|corpus|prospectus)(es)?$/i, '$1'],
    [/(x|ch|ss|sh)es$/i, '$1'],
    [/(o)es$/i, '$1'],
    [/([^aeiouy]|qu)ies$/i, '$1y'],
    [/(ss|us|is)$/i, '$1'],
    [/s$/i, ''],
  ];
  for (const [re, rep] of rules) if (re.test(word)) return word.replace(re, rep);
  return word;
}

/** Laravel's resource wildcard: `Str::singular` of the last segment with `-` replaced by `_`. */
export function resourceParam(resourceName: string): string {
  const last = resourceName.split(/[./]/).filter(Boolean).pop() ?? 'id';
  return singularWord(last).replace(/-/g, '_') || 'id';
}

const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', 'storage', 'bootstrap', 'public', 'resources', 'tests', 'dist', '.mapx']);

function isLaravelRoot(abs: string): boolean {
  if (existsSync(join(abs, 'artisan'))) return true;
  const composer = join(abs, 'composer.json');
  if (!existsSync(composer)) return false;
  try {
    const json = JSON.parse(readFileSync(composer, 'utf8'));
    const deps = { ...json.require, ...json['require-dev'] };
    return 'laravel/framework' in deps || 'laravel/lumen-framework' in deps;
  } catch {
    return false;
  }
}

/**
 * Laravel application roots under `workspaceRoot` (workspace-relative, '' for the root itself).
 * Looks up to `maxDepth` levels down, so parent-folder workspaces find their nested apps.
 */
export function findLaravelRoots(workspaceRoot: string, maxDepth = 3): string[] {
  if (isLaravelRoot(workspaceRoot)) return [''];
  const roots: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(join(workspaceRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (isLaravelRoot(join(workspaceRoot, child))) roots.push(child);
      else walk(child, depth + 1);
    }
  };
  walk('', 1);
  return roots.sort();
}

/**
 * True when the text before a `{` (or before a brace-less statement) opens an
 * `if`/`elseif`/`else`/`switch` body. `if (! $this->app->routesAreCached())` is not conditional:
 * Laravel loads the same routes from its cache otherwise.
 */
export function opensConditionalBlock(before: string): boolean {
  const tail = before.slice(-300).replace(/\s+$/, '');
  if (/\belse$/.test(tail)) return true;
  if (!tail.endsWith(')')) return false;
  // Walk back to the matching '(' and look at the keyword in front of it.
  let depth = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const c = tail[i];
    if (c === ')') depth++;
    else if (c === '(' && --depth === 0) {
      if (!/\b(if|elseif|else\s+if|switch)\s*$/.test(tail.slice(0, i))) return false;
      return !/^\(\s*!?\s*(?:(?:\$this\s*->\s*app|app\s*\(\s*\))\s*->\s*|App::)routesAreCached\s*\(\s*\)\s*\)$/.test(tail.slice(i));
    }
  }
  return false;
}

/**
 * Files matching a PHP `glob()` pattern (workspace-relative, `*`, `?` and `[...]` in any
 * segment), sorted as PHP's glob() returns them.
 */
export function expandGlob(workspaceRoot: string, pattern: string): string[] {
  const segments = normalizeMountPath(pattern).split('/').filter(Boolean);
  let matches = [''];
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    const next: string[] = [];
    for (const dir of matches) {
      if (!/[*?[]/.test(segment)) {
        const child = dir ? `${dir}/${segment}` : segment;
        if (existsSync(join(workspaceRoot, child))) next.push(child);
        continue;
      }
      const re = new RegExp(`^${segment.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
      let entries;
      try {
        entries = readdirSync(join(workspaceRoot, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries)
        if (re.test(e.name) && !e.name.startsWith('.') && (last || e.isDirectory())) next.push(dir ? `${dir}/${e.name}` : e.name);
    }
    matches = next.sort();
  }
  return matches;
}
