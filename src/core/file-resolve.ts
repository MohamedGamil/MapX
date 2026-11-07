// File arguments as `mapx deps` and mapx_dependencies take them: an exact path, a glob or a partial
// name (M0-03-R4: mapx_dependencies used to take only an exact indexed path).
import picomatch from 'picomatch';
import { isGlobPattern } from './fuzzy-matcher.js';

/**
 * Resolve a file argument to one or more tracked file paths.
 *
 * Resolution order:
 *  1. Exact match in the tracked file set.
 *  2. Glob / wildcard match (*, ?) against all tracked paths — returns all matches.
 *  3. Substring / prefix match — returns all paths containing the input as a substring.
 *
 * Returns `null` when no match is found so callers can print a helpful error.
 */
export function resolveFilePaths(input: string, allFiles: Array<{ path: unknown }>): string[] | null {
  const paths = allFiles.map(f => f.path as string);

  // 1. Exact match
  if (paths.includes(input)) return [input];

  // 2. Glob wildcard: *, ?, **
  if (isGlobPattern(input) || input.includes('/')) {
    const matchBase = !input.includes('/');
    const isMatch = picomatch(input, { dot: true, nocase: true, matchBase });
    const matches = paths.filter(p => isMatch(p) || p.endsWith(input) || p.includes(input));
    if (matches.length > 0) return matches;
  }

  // 3. Substring fallback
  const lower = input.toLowerCase();
  const substr = paths.filter(p => p.toLowerCase().includes(lower));
  if (substr.length > 0) return substr;

  return null;
}

/** The error for a file argument that matches no tracked path; `deps` prints it and the tip on stderr / stdout. */
export function fileNotFoundMessage(input: string): { error: string; tip: string } {
  return {
    error: `File "${input}" not found in index.`,
    tip: 'Tip: Use globs (src/core/*.ts), partial names (scanner), or run mapx files to list all tracked files.',
  };
}
