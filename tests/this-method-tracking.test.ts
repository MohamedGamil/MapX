import { describe, it, expect } from 'vitest';
import { getParserForFile } from '../src/parsers/parser-registry.js';

describe('this.method() tracking', () => {
  it('should capture this.method() call expressions as references', async () => {
    const parser = getParserForFile('test.ts');
    expect(parser).toBeDefined();

    const code = `
      class User {
        private fetchDetails() {}
        public load() {
          this.fetchDetails();
        }
      }
    `;

    const result = await parser.parse('test.ts', code);
    expect(result.errors).toEqual([]);

    // Check that we captured the call to 'fetchDetails'
    const ref = result.references.find(r => r.targetName === 'fetchDetails');
    expect(ref).toBeDefined();
    expect(ref?.referenceType).toBe('call');
  });

  it('should not capture this.property access that is not a call', async () => {
    const parser = getParserForFile('test.ts');
    const code = `
      class User {
        private id: number = 10;
        public getID() {
          return this.id;
        }
      }
    `;

    const result = await parser.parse('test.ts', code);
    expect(result.errors).toEqual([]);

    // 'id' is a property access, not a call, so it should not be tracked as a reference
    const ref = result.references.find(r => r.targetName === 'id');
    expect(ref).toBeUndefined();
  });

  it('should capture chained calls like this.helper().execute() correctly', async () => {
    const parser = getParserForFile('test.ts');
    const code = `
      class Command {
        execute() {}
        helper() { return this; }
        run() {
          this.helper().execute();
        }
      }
    `;

    const result = await parser.parse('test.ts', code);
    expect(result.errors).toEqual([]);

    // Should capture 'helper'
    const helperRef = result.references.find(r => r.targetName === 'helper');
    expect(helperRef).toBeDefined();
    expect(helperRef?.referenceType).toBe('call');
  });

  it('should capture this.method() calls in javascript files', async () => {
    const parser = getParserForFile('test.js');
    const code = `
      class User {
        fetchDetails() {}
        load() {
          this.fetchDetails();
        }
      }
    `;

    const result = await parser.parse('test.js', code);
    expect(result.errors).toEqual([]);

    const ref = result.references.find(r => r.targetName === 'fetchDetails');
    expect(ref).toBeDefined();
    expect(ref?.referenceType).toBe('call');
  });
});
