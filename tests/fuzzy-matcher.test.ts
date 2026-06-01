import { describe, it, expect } from 'vitest';
import { findSimilarSymbols, globToLike, isGlobPattern, isWildcard } from '../src/core/fuzzy-matcher.js';

describe('fuzzy-matcher', () => {
  describe('isWildcard', () => {
    it('should detect empty string as wildcard', () => {
      expect(isWildcard('')).toBe(true);
    });

    it('should detect single asterisk as wildcard', () => {
      expect(isWildcard('*')).toBe(true);
    });

    it('should not treat regular terms as wildcard', () => {
      expect(isWildcard('Store')).toBe(false);
      expect(isWildcard('*Service')).toBe(false);
    });
  });

  describe('isGlobPattern', () => {
    it('should detect asterisk glob patterns', () => {
      expect(isGlobPattern('*Service')).toBe(true);
      expect(isGlobPattern('get*')).toBe(true);
      expect(isGlobPattern('*Controller*')).toBe(true);
    });

    it('should detect question mark glob patterns', () => {
      expect(isGlobPattern('get?')).toBe(true);
    });

    it('should not treat regular terms as glob', () => {
      expect(isGlobPattern('Store')).toBe(false);
      expect(isGlobPattern('UserService')).toBe(false);
    });

    it('should treat pure wildcard as glob too (superset check handled by isWildcard)', () => {
      // isGlobPattern returns true for '*' since it contains a glob char
      // Consumer code checks isWildcard() first to distinguish
      expect(isGlobPattern('*')).toBe(true);
      expect(isGlobPattern('')).toBe(false);
    });
  });

  describe('globToLike', () => {
    it('should convert * to %', () => {
      expect(globToLike('*Service')).toBe('%Service');
      expect(globToLike('get*')).toBe('get%');
      expect(globToLike('*Controller*')).toBe('%Controller%');
    });

    it('should convert ? to _', () => {
      expect(globToLike('get?')).toBe('get_');
    });

    it('should pass through literal % characters (no SQL escaping)', () => {
      // globToLike intentionally does NOT escape raw % — users pass glob, not SQL
      expect(globToLike('test%value')).toBe('test%value');
    });

    it('should handle combined patterns', () => {
      expect(globToLike('*foo?bar*')).toBe('%foo_bar%');
    });
  });

  describe('findSimilarSymbols', () => {
    const candidates = [
      { name: 'Store', kind: 'class', filePath: 'src/core/store.ts' },
      { name: 'StoreBackend', kind: 'interface', filePath: 'src/core/store-interface.ts' },
      { name: 'Scanner', kind: 'class', filePath: 'src/core/scanner.ts' },
      { name: 'Config', kind: 'class', filePath: 'src/core/config.ts' },
      { name: 'FlowTracer', kind: 'class', filePath: 'src/core/flow-tracer.ts' },
      { name: 'MapxGraph', kind: 'class', filePath: 'src/core/graph.ts' },
    ];

    it('should find similar symbols for typos', () => {
      const results = findSimilarSymbols('Stor', candidates);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Store');
    });

    it('should find similar symbols for case mismatches', () => {
      const results = findSimilarSymbols('store', candidates);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.name === 'Store')).toBe(true);
    });

    it('should return empty array for completely unrelated terms', () => {
      const results = findSimilarSymbols('zzzzzzzzzzz', candidates);
      expect(results.length).toBe(0);
    });

    it('should limit results to maxResults', () => {
      const results = findSimilarSymbols('S', candidates, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return results with correct structure', () => {
      const results = findSimilarSymbols('Config', candidates);
      expect(results.length).toBeGreaterThan(0);
      const first = results[0];
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('kind');
      expect(first).toHaveProperty('filePath');
    });
  });
});
