import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Worker Thread Parsing Integration', () => {
  const tempDir = resolve(__dirname, '../temp_worker_test');

  beforeAll(() => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'file1.ts'),
      `export class Greeter { greet() { return "hello"; } }`
    );
    writeFileSync(
      join(tempDir, 'file2.ts'),
      `export function add(a: number, b: number) { return a + b; }`
    );
    writeFileSync(
      join(tempDir, 'static.md'),
      `This is a [link](./another.md) in markdown.`
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse files using worker threads and match main thread results', async () => {
    const store = new Store(':memory:');
    const config = {
      getWorkspaceRoot: () => resolve(__dirname, '..'),
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'test-repo', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] },
    } as unknown as Config;
    const graph = new MapxGraph('test-repo');
    const scanner = new Scanner(store, config, graph);

    const files = [
      {
        absolutePath: join(tempDir, 'file1.ts'),
        language: 'typescript',
        sizeBytes: 100,
        lines: 5,
      },
      {
        absolutePath: join(tempDir, 'file2.ts'),
        language: 'typescript',
        sizeBytes: 100,
        lines: 5,
      },
      {
        absolutePath: join(tempDir, 'static.md'),
        language: 'markdown',
        sizeBytes: 100,
        lines: 3,
      },
    ];

    // Parse with workers
    const workerResults = await (scanner as any).parseWithWorkers(files, resolve(__dirname, '..'));
    expect(workerResults).toHaveLength(3);
    expect(workerResults[0].errors).toHaveLength(0);
    expect(workerResults[1].errors).toHaveLength(0);
    expect(workerResults[2].errors).toHaveLength(0);

    // Verify symbols
    const hasGreeter = workerResults[0].symbols.some((s: { name: string }) => s.name === 'Greeter');
    const hasAdd = workerResults[1].symbols.some((s: { name: string }) => s.name === 'add');
    expect(hasGreeter).toBe(true);
    expect(hasAdd).toBe(true);

    // Verify static markdown reference extraction
    const hasMarkdownLink = workerResults[2].references.some((r: { targetName: string }) => r.targetName === './another.md');
    expect(hasMarkdownLink).toBe(true);

    // Parse on main thread for comparison
    const mainResults = await (scanner as any).parseOnMainThread(files, resolve(__dirname, '..'));
    expect(mainResults).toHaveLength(3);
    expect(mainResults[0].symbols).toEqual(workerResults[0].symbols);
    expect(mainResults[1].symbols).toEqual(workerResults[1].symbols);
    expect(mainResults[2].references).toEqual(workerResults[2].references);
  });
});
