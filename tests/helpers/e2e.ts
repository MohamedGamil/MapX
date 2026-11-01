// End-to-end helpers: build a throwaway workspace, run the real CLI on it, query the store.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll } from 'vitest';

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

/** Like `mapx`, with extra environment variables (e.g. NODE_OPTIONS for a test preload). */
export function mapxEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Like `mapx`, but returns stderr too (for asserting warnings). */
export function mapxWithStderr(cwd: string, ...args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' },
  });
  if (r.status !== 0) throw new Error(`mapx ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

/** Runs the CLI without throwing, for asserting exit codes and error messages. */
export function mapxResult(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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

/**
 * Makes this test file's scans parse on `n` workers (MAPX_PARSE_WORKERS), restoring the variable
 * afterwards. Test projects are far below the automatic break-even (M4-13), so a test that means to
 * exercise the workers says so.
 */
export function useParseWorkers(n: number | 'auto' = 4): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env['MAPX_PARSE_WORKERS'];
    process.env['MAPX_PARSE_WORKERS'] = String(n);
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['MAPX_PARSE_WORKERS'];
    else process.env['MAPX_PARSE_WORKERS'] = saved;
  });
}
