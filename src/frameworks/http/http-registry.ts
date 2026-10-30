// Persists frontend HTTP call sites in .mapx/http-calls.json (contract D008).
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpClientRef } from './client-calls.js';
import type { PairedRoute } from './pairing.js';

export interface HttpCallRecord {
  file: string;
  line: number;
  method: string;
  rawUrl: string;
  /** Resolved request path (M2-04/M2-05); absent until resolution can evaluate it. */
  url?: string;
  /** The client has a base URL that could not be evaluated; `url` is then relative to it. */
  baseURLUnresolved?: boolean;
  client: HttpClientRef;
  /** Paired backend route (M2-06); null when no live route serves the call. */
  route?: PairedRoute | null;
}

export class HttpCallRegistry {
  private records: HttpCallRecord[] = [];

  getRecords(): HttpCallRecord[] {
    return this.records;
  }

  async load(workspaceRoot: string): Promise<void> {
    const path = join(workspaceRoot, '.mapx', 'http-calls.json');
    try {
      this.records = existsSync(path) ? JSON.parse(await readFile(path, 'utf-8')) : [];
    } catch {
      this.records = [];
    }
  }

  /** Replaces every record of the given files (a repo's file set) with `records`. */
  setRecords(records: HttpCallRecord[]): void {
    this.records = records;
  }

  /** Removes records whose file is not in `existing` (deleted files). */
  dropMissing(existing: Set<string>): void {
    this.records = this.records.filter(r => existing.has(r.file));
  }

  replaceFiles(files: Set<string>, records: HttpCallRecord[]): void {
    this.records = [...this.records.filter(r => !files.has(r.file)), ...records].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
  }

  async save(workspaceRoot: string): Promise<void> {
    await writeFile(join(workspaceRoot, '.mapx', 'http-calls.json'), JSON.stringify(this.records, null, 2), 'utf-8');
  }
}

/** HTTP call records for `mapx routes --clients` and `mapx_routes { clients }`. */
export async function loadClientCalls(
  workspaceRoot: string,
  filters: { unmatched?: boolean; method?: string; path?: string } = {},
): Promise<HttpCallRecord[]> {
  const registry = new HttpCallRegistry();
  await registry.load(workspaceRoot);
  return registry.getRecords().filter(r =>
    (!filters.unmatched || !r.route) &&
    (!filters.method || r.method.toUpperCase() === filters.method.toUpperCase()) &&
    (!filters.path || (r.url ?? r.rawUrl).toLowerCase().includes(filters.path.toLowerCase())),
  );
}
