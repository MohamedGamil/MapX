import { describe, it, expect } from 'vitest';
import { createDatabasePath } from '../src/core/store-interface.js';
import { join } from 'node:path';

describe('store-interface', () => {
  it('createDatabasePath returns correct path', () => {
    const result = createDatabasePath('/workspace');
    expect(result).toBe(join('/workspace', '.mapx', 'mapx.db'));
  });

  it('createDatabasePath handles nested workspace path', () => {
    const result = createDatabasePath('/home/user/projects/my-app');
    expect(result).toBe(join('/home/user/projects/my-app', '.mapx', 'mapx.db'));
  });

  it('createDatabasePath handles relative-looking workspace path', () => {
    const result = createDatabasePath('.');
    expect(result).toBe(join('.', '.mapx', 'mapx.db'));
  });
});
