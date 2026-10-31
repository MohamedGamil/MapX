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

const PATH_HELPERS: Record<string, string> = {
  base_path: '',
  app_path: 'app',
  config_path: 'config',
  database_path: 'database',
  resource_path: 'resources',
};

/**
 * Evaluates a PHP string expression made of literals, local variables, `__DIR__`,
 * `dirname(__DIR__)` and Laravel path helpers. Returns null when any part is dynamic.
 * Path-like results are workspace-relative.
 */
export function phpString(expr: string, scope: PhpScope): string | null {
  const parts = splitConcat(expr.trim());
  let out = '';
  for (const part of parts) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(QUOTED))) {
      if (m[1] === '"' && /\$\w/.test(m[2]!)) return null; // interpolation
      out += m[2]!.replace(/\\(['"\\])/g, '$1');
    } else if (part === '__DIR__') {
      out += scope.dir;
    } else if ((m = part.match(/^dirname\s*\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\)$/))) {
      let dir = scope.dir;
      for (let i = 0; i < Number(m[1] ?? 1); i++) dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
      out += dir;
    } else if ((m = part.match(/^\$(\w+)$/))) {
      const value = scope.vars.get(m[1]!);
      if (value === undefined) return null;
      out += value;
    } else if ((m = part.match(/^(\w+)\s*\(\s*(.*?)\s*\)$/s)) && m[1]! in PATH_HELPERS) {
      const inner = m[2] ? phpString(m[2], scope) : '';
      if (inner === null) return null;
      out += posix.join(scope.root, PATH_HELPERS[m[1]!]!, inner);
    } else {
      return null;
    }
  }
  return out;
}

/** Normalises a path built from `__DIR__` etc. into a workspace-relative POSIX path. */
export function normalizeMountPath(path: string): string {
  const joined = posix.normalize(path.replace(/\\/g, '/'));
  return joined.replace(/^\.\/?/, '').replace(/^\/+/, '');
}

/** Collects `$name = 'literal';` assignments with their offsets, for position-aware lookup. */
export function stringAssignments(content: string): { name: string; value: string; index: number }[] {
  const result: { name: string; value: string; index: number }[] = [];
  const re = /\$(\w+)\s*=\s*((['"])(?:\\.|(?!\3).)*\3)\s*;/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
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

/** True when the text before a `{` opens an `if`/`elseif`/`else`/`switch` block. */
export function opensConditionalBlock(before: string): boolean {
  const tail = before.slice(-300).replace(/\s+$/, '');
  if (/\belse$/.test(tail)) return true;
  if (!tail.endsWith(')')) return false;
  // Walk back to the matching '(' and look at the keyword in front of it.
  let depth = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const c = tail[i];
    if (c === ')') depth++;
    else if (c === '(' && --depth === 0) return /\b(if|elseif|else\s+if|switch)\s*$/.test(tail.slice(0, i));
  }
  return false;
}
