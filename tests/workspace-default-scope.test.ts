import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, mapxWithStderr, query, workspace } from './helpers/e2e.js';

// M0-10-R5: a workspace registering a root repo and nested git repos (backend/, frontend/) is
// scanned and synced whole when neither --repo nor --all is given, from the CLI and from MCP.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const rows = (root: string) => ({
  files: query(root, 'SELECT repo, path, content_hash FROM files ORDER BY repo, path'),
  symbols: query(root, 'SELECT repo, file_path, name, kind, start_line FROM symbols ORDER BY repo, file_path, name, start_line'),
  edges: query(root, `SELECT repo, source_file, source_symbol, target_file, target_symbol, edge_type FROM edges
    ORDER BY repo, source_file, source_symbol, target_file, target_symbol, edge_type`),
});
const symbolsOf = (root: string, repo: string) =>
  query<{ name: string }>(root, 'SELECT name FROM symbols WHERE repo = ? ORDER BY name', repo).map((s) => s.name);

describe('scan and sync with no repo named cover every registered repo (real CLI)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'tools/root.ts': 'export function rootTool() { return 1; }\n',
      'backend/app/User.php': '<?php\nnamespace App;\nclass User { public function name() { return helper(); } }\nfunction helper() { return 1; }\n',
      'frontend/src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
      'frontend/src/b.ts': 'export function b() { return 1; }\n',
    });
    for (const dir of ['backend', 'frontend', '.']) {
      git(join(root, dir), 'init', '-q');
      git(join(root, dir), 'add', '-A');
      git(join(root, dir), 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'workspaces', 'add', 'backend');
    mapx(root, 'workspaces', 'add', 'frontend');
  }, 120000);
  afterEach(() => cleanup(root));

  it('scan --force at the workspace root re-indexes the nested repos, as scan --all on a fresh index does', () => {
    appendFileSync(join(root, 'backend/app/User.php'), 'function addedInBackend() { return helper(); }\n');
    appendFileSync(join(root, 'frontend/src/b.ts'), 'export function addedInFrontend() { return b(); }\n');
    mapx(root, 'scan', '--force');
    expect(symbolsOf(root, 'backend')).toContain('addedInBackend');
    expect(symbolsOf(root, 'frontend')).toContain('addedInFrontend');
    const scanned = rows(root);
    expect(new Set((scanned.files as Array<{ repo: string }>).map((f) => f.repo)).size).toBe(3);

    unlinkSync(join(root, '.mapx/mapx.db'));
    mapx(root, 'scan', '--all');
    expect(scanned).toEqual(rows(root));
  }, 120000);

  it('a plain scan and a plain sync at the root pick up a nested repo\'s edits', () => {
    appendFileSync(join(root, 'frontend/src/b.ts'), 'export function viaScan() { return 2; }\n');
    mapx(root, 'scan');
    expect(symbolsOf(root, 'frontend')).toContain('viaScan');

    appendFileSync(join(root, 'backend/app/User.php'), 'function viaSync() { return 3; }\n');
    mapx(root, 'sync');
    expect(symbolsOf(root, 'backend')).toContain('viaSync');
  }, 120000);

  it('--repo still limits the scan to the named repo', () => {
    mapx(root, 'scan');
    appendFileSync(join(root, 'backend/app/User.php'), 'function notScanned() { return 4; }\n');
    appendFileSync(join(root, 'frontend/src/b.ts'), 'export function scannedHere() { return 5; }\n');
    appendFileSync(join(root, 'tools/root.ts'), 'export function rootNotScanned() { return 4; }\n');
    mapx(root, 'scan', '--repo', 'frontend');
    expect(symbolsOf(root, 'frontend')).toContain('scannedHere');
    expect(symbolsOf(root, 'backend')).not.toContain('notScanned');
    const primary = query<{ repo: string }>(root, "SELECT repo FROM files WHERE path = 'tools/root.ts'")[0]!.repo;
    expect(symbolsOf(root, primary)).not.toContain('rootNotScanned');
  }, 120000);

  it('skips a registered repo whose folder is missing, keeping its index, and scans the others (review 2026-11-01)', () => {
    mapx(root, 'scan');
    const frontendBefore = rows(root).files.filter((f: any) => f.repo === 'frontend');
    renameSync(join(root, 'frontend'), join(root, '..', `${root.split('/').pop()}-frontend-away`));
    try {
      appendFileSync(join(root, 'backend/app/User.php'), 'function afterMove() { return 8; }\n');
      const synced = mapxWithStderr(root, 'sync');
      expect(synced.stdout + synced.stderr).toMatch(/Skipped repo frontend: its folder .* does not exist/);
      expect(symbolsOf(root, 'backend')).toContain('afterMove');

      appendFileSync(join(root, 'tools/root.ts'), 'export function rootAfterMove() { return 9; }\n');
      mapxWithStderr(root, 'scan', '--force');
      const primary = query<{ repo: string }>(root, "SELECT repo FROM files WHERE path = 'tools/root.ts'")[0]!.repo;
      expect(symbolsOf(root, primary)).toContain('rootAfterMove');
      expect(rows(root).files.filter((f: any) => f.repo === 'frontend')).toEqual(frontendBefore);
    } finally {
      renameSync(join(root, '..', `${root.split('/').pop()}-frontend-away`), join(root, 'frontend'));
    }
  }, 120000);

  it('the MCP mapx_scan and mapx_sync tools with no repo argument cover the nested repos', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      appendFileSync(join(root, 'backend/app/User.php'), 'function viaMcpSync() { return 6; }\n');
      await client.callTool({ name: 'mapx_sync', arguments: { dir: root } });
      expect(symbolsOf(root, 'backend')).toContain('viaMcpSync');

      appendFileSync(join(root, 'frontend/src/b.ts'), 'export function viaMcpScan() { return 7; }\n');
      await client.callTool({ name: 'mapx_scan', arguments: { dir: root } });
      expect(symbolsOf(root, 'frontend')).toContain('viaMcpScan');
    } finally {
      await client.close();
    }
  }, 120000);
});
