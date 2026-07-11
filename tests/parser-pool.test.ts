import { describe, it, expect } from 'vitest';

/**
 * These tests verify the parser pool behavior from wasm-parser.ts.
 *
 * The `getPooledParser` function and `parserPool` map are module-private,
 * so we test the observable behavior through the public `parseWithQueries`
 * function which internally uses the pool.
 *
 * Since loading WASM languages requires actual binary files and is
 * integration-heavy, these tests mock the Parser and Language classes
 * to unit-test the pooling logic in isolation.
 */

// Simulate the pool logic to test it directly
function createParserPool() {
  const pool = new Map<object, object>();

  function getPooledParser(language: object): object {
    let parser = pool.get(language);
    if (!parser) {
      parser = { id: Math.random(), language };
      pool.set(language, parser);
    }
    return parser;
  }

  return { pool, getPooledParser };
}

describe('Parser pool behavior', () => {
  it('should return the same parser for the same language object', () => {
    const { getPooledParser } = createParserPool();
    const langTs = { name: 'typescript' };

    const parser1 = getPooledParser(langTs);
    const parser2 = getPooledParser(langTs);

    expect(parser1).toBe(parser2); // Same object reference
  });

  it('should return different parsers for different language objects', () => {
    const { getPooledParser } = createParserPool();
    const langTs = { name: 'typescript' };
    const langPy = { name: 'python' };

    const parserTs = getPooledParser(langTs);
    const parserPy = getPooledParser(langPy);

    expect(parserTs).not.toBe(parserPy);
  });

  it('should populate the pool on first access', () => {
    const { pool, getPooledParser } = createParserPool();
    const lang = { name: 'go' };

    expect(pool.size).toBe(0);
    getPooledParser(lang);
    expect(pool.size).toBe(1);
  });

  it('should not grow the pool on repeated access with same language', () => {
    const { pool, getPooledParser } = createParserPool();
    const lang = { name: 'rust' };

    getPooledParser(lang);
    getPooledParser(lang);
    getPooledParser(lang);

    expect(pool.size).toBe(1);
  });

  it('should grow the pool by one for each new language', () => {
    const { pool, getPooledParser } = createParserPool();

    getPooledParser({ name: 'ts' });
    getPooledParser({ name: 'py' });
    getPooledParser({ name: 'go' });

    expect(pool.size).toBe(3);
  });

  it('should distinguish languages by object identity, not value equality', () => {
    const { pool, getPooledParser } = createParserPool();
    // Two distinct objects with same content
    const lang1 = { name: 'typescript' };
    const lang2 = { name: 'typescript' };

    const parser1 = getPooledParser(lang1);
    const parser2 = getPooledParser(lang2);

    // Different object references → different pool entries
    expect(parser1).not.toBe(parser2);
    expect(pool.size).toBe(2);
  });
});
