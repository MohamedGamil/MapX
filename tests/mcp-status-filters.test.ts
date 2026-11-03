// M4-28-R2: `mapx_status` applies the exclude/include patterns it accepts, as `mapx status` does.
// M4-28 found the tool declaring both and ignoring them, and the CLI only printing them. A git
// workspace scanned with the real CLI gets a changed file under src/ and one under lib/, and a new
// file under src/; the tool and the CLI must list the same changed files for the same patterns.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, mapxResult, workspace } from './helpers/e2e.js';

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });

/** The changed files a status lists: its `+ path`, `~ path`, `- path` lines. */
const listed = (text: string) => [...text.matchAll(/^\s+[+~\->=] (\S+)$/gm)].map((m) => m[1]!).sort();

describe('mapx_status narrows the changed files with exclude and include, as mapx status does', () => {
  let root = '';
  let client: Client;
  const status = async (args: Record<string, unknown>) =>
    ((await client.callTool({ name: 'mapx_status', arguments: { dir: root, ...args } })) as { content: Array<{ text: string }> }).content[0]!.text;

  beforeAll(async () => {
    root = workspace({
      'src/a.ts': 'export const a = 1;\n',
      'lib/b.ts': 'export const b = 1;\n',
      '.gitignore': '.mapx/\n',
    }, ['.']);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', root);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'lib/b.ts'), 'export const b = 2;\n');
    writeFileSync(join(root, 'src/new.ts'), 'export const n = 1;\n');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'status-filters', version: '1.0.0' });
    await client.connect(clientSide);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    if (root) cleanup(root);
  });

  it('lists every changed file without patterns, as the CLI does', async () => {
    const text = await status({});
    expect(listed(text)).toEqual(['lib/b.ts', 'src/a.ts', 'src/new.ts']);
    expect(text).toContain('3 changed files');
    expect(listed(mapx(root, 'status', root))).toEqual(listed(text));
  });

  it('exclude: ["src/**"] reports no changed file under src/ while one exists, as --exclude does', async () => {
    const text = await status({ exclude: ['src/**'] });
    expect(listed(text)).toEqual(['lib/b.ts']);
    expect(text).toContain('1 changed files');
    expect(listed(mapx(root, 'status', root, '--exclude', 'src/**'))).toEqual(['lib/b.ts']);
    // The comma-separated string form the other tools take works too.
    expect(listed(await status({ exclude: 'src/**, docs/**' }))).toEqual(['lib/b.ts']);
  });

  it('include keeps only the matching changed files; an exclude wins over it', async () => {
    expect(listed(await status({ include: ['src/**'] }))).toEqual(['src/a.ts', 'src/new.ts']);
    expect(listed(mapx(root, 'status', root, '--include', 'src/**'))).toEqual(['src/a.ts', 'src/new.ts']);
    const both = await status({ include: 'src/**', exclude: 'src/new.ts' });
    expect(listed(both)).toEqual(['src/a.ts']);
    expect(listed(mapx(root, 'status', root, '--include', 'src/**', '--exclude', 'src/new.ts'))).toEqual(['src/a.ts']);
  });

  it('reports the index current when the patterns leave no changed file', async () => {
    const text = await status({ exclude: ['src/**', 'lib/**'] });
    expect(listed(text)).toEqual([]);
    expect(text).toContain('No changes since last scan');
    expect(mapx(root, 'status', root, '--exclude', 'src/**', '--exclude', 'lib/**')).toContain('No changes since last scan');
  });

  // Review of M4-28-R2 (P1): an empty pattern reached picomatch, which threw "Expected pattern to
  // be a non-empty string", and `mapx status` exited 1.
  it('ignores empty patterns (a trailing comma, an empty or blank --include) in the CLI and the tool', async () => {
    const trailing = mapxResult(root, 'status', root, '--exclude', 'src/**,');
    expect(trailing.stderr).not.toMatch(/TypeError|non-empty string/);
    expect(trailing.status).toBe(0);
    expect(listed(trailing.stdout)).toEqual(['lib/b.ts']);
    const empty = mapxResult(root, 'status', root, '--include', '', '--exclude', ' ');
    expect(empty.status).toBe(0);
    expect(listed(empty.stdout)).toEqual(['lib/b.ts', 'src/a.ts', 'src/new.ts']);
    expect(listed(await status({ exclude: 'src/**,' }))).toEqual(['lib/b.ts']);
    expect(listed(await status({ include: [''], exclude: [' '] }))).toEqual(['lib/b.ts', 'src/a.ts', 'src/new.ts']);
  });

  it('splits a comma inside an array element, as the CLI splits --exclude a,b', async () => {
    expect(listed(await status({ exclude: ['src/**,lib/**'] }))).toEqual([]);
    expect(listed(await status({ include: ['lib/**, src/new.ts'] }))).toEqual(['lib/b.ts', 'src/new.ts']);
    expect(listed(mapx(root, 'status', root, '--include', 'lib/**, src/new.ts'))).toEqual(['lib/b.ts', 'src/new.ts']);
  });

  it('lists at most `limit` changed files, with the total and a truncation note', async () => {
    const cut = await status({ limit: 1 });
    expect(listed(cut)).toHaveLength(1);
    expect(cut).toContain('3 changed files');
    expect(cut).toContain('… 2 more (showing 1 of 3; pass limit: 0 to list all)');
    expect(listed(await status({ limit: 0 }))).toEqual(['lib/b.ts', 'src/a.ts', 'src/new.ts']);
    expect(await status({})).not.toContain('more (showing');
  });
});

describe('scan and update take an empty --include or --exclude', () => {
  it('`mapx scan --include \'\' --exclude \'none/**,\'` indexes as without them', () => {
    const root = workspace({ 'src/a.ts': 'export const a = 1;\n', 'lib/b.ts': 'export const b = 1;\n' });
    try {
      init(root);
      const r = mapxResult(root, 'scan', root, '--include', '', '--exclude', 'none/**,');
      expect(r.stderr).not.toMatch(/TypeError|non-empty string/);
      expect(r.status).toBe(0);
      expect(listed(mapx(root, 'status', root))).toEqual([]);
      const files = mapx(root, 'query', 'a', '-d', root);
      expect(files).toContain('src/a.ts');
    } finally {
      cleanup(root);
    }
  }, 60_000);
});
