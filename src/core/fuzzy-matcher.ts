import Fuse from 'fuse.js';

/**
 * Fuzzy symbol name matcher using Fuse.js.
 * Provides typo-tolerant search with ranked suggestions when exact/LIKE matching fails.
 */

export interface FuzzyMatch {
  name: string;
  score: number;       // 0 = perfect, 1 = worst (Fuse convention)
  kind?: string;
  filePath?: string;
}

/**
 * Find symbols with names similar to the target using fuzzy matching.
 *
 * @param target - The search term (possibly misspelled)
 * @param candidates - Array of { name, kind, file_path } records from the symbols table
 * @param maxResults - Maximum number of suggestions to return (default: 5)
 * @param threshold - Fuse.js threshold 0-1; lower = stricter matching (default: 0.4)
 */
export function findSimilarSymbols(
  target: string,
  candidates: Array<{ name: string; kind?: string; file_path?: string }>,
  maxResults: number = 5,
  threshold: number = 0.4
): FuzzyMatch[] {
  if (candidates.length === 0 || !target) return [];

  const fuse = new Fuse(candidates, {
    keys: ['name'],
    threshold,
    includeScore: true,
    shouldSort: true,
    minMatchCharLength: Math.max(2, Math.floor(target.length * 0.5)),
  });

  const results = fuse.search(target, { limit: maxResults });

  return results.map(r => ({
    name: r.item.name,
    score: r.score ?? 1,
    kind: r.item.kind,
    filePath: r.item.file_path,
  }));
}

/**
 * Convert a glob-style pattern to a SQL LIKE pattern.
 *
 * Supported conversions:
 *   *  → %  (match any characters)
 *   ?  → _  (match single character)
 *
 * Other characters are passed through as-is.
 * SQL LIKE special characters (% and _) in the input that are NOT glob
 * wildcards are NOT escaped — this is intentional since users shouldn't
 * be passing raw SQL; they should be passing glob-style patterns.
 */
export function globToLike(pattern: string): string {
  return pattern
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}

/**
 * Check if a search term contains glob-style wildcards.
 */
export function isGlobPattern(term: string): boolean {
  return term.includes('*') || term.includes('?');
}

/**
 * Check if a search term is a "list all" wildcard.
 */
export function isWildcard(term: string): boolean {
  return !term || term === '*';
}
