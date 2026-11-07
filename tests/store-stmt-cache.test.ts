import { describe, it, expect } from 'vitest';
import { NodeStore } from '../src/core/store-node.js';

// M0-39: the prepared-statement cache (CHANGELOG 0.3.4).
describe('NodeStore prepared statement cache', () => {
  it('compiles each SQL text once and reuses the statement', () => {
    const backend = new NodeStore(':memory:');
    const a = backend.prepare('SELECT 1 AS one');
    expect(backend.prepare('SELECT 1 AS one')).toBe(a);
    expect(backend.prepare('SELECT 2 AS two')).not.toBe(a);
    expect(a.get()).toEqual({ one: 1 });
  });
});
