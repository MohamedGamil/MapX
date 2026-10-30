// End-to-end helpers: build a throwaway workspace, run the real CLI on it, query the store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const MAIN = resolve(__dirname, '../../src/main.ts');
// Absolute loader URL: the temp workspace has no node_modules to resolve `tsx` from.
const TSX = pathToFileURL(resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs')).href;

export function workspace(files: Record<string, string>, gitDirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'mapx-e2e-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const dir of gitDirs) execFileSync('git', ['init', '-q', join(root, dir)]);
  return root;
}

export function mapx(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function init(root: string): void {
  mapx(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
}

export function query<T = Record<string, unknown>>(root: string, sql: string, ...params: unknown[]): T[] {
  const db = new Database(join(root, '.mapx', 'mapx.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
