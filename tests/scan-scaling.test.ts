import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scanner } from '../src/core/scanner.js';
import { closest, nearestIndex } from '../src/core/import-resolvers.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';

// M4-03: no scan phase grows quadratically with the number of files (docs/baton/iterations/M4-03.md).

const memoryConfig = (root = '/workspace') => ({
  getWorkspaceRoot: () => root,
  getResolvedUserLanguages: () => ({}),
  repos: [{ name: 'repo1', path: '.' }],
  settings: { excludePatterns: [], includePatterns: [] },
}) as unknown as Config;

describe('name resolution on a name declared in every file', () => {
  it('resolves 20,000 calls to a method declared in 20,000 files in linear time, with the same answers', () => {
    const N = 20000;
    const scanner = new Scanner(new Store(':memory:'), memoryConfig(), new MapxGraph('repo1'));
    const file = (i: number) => `src/d${i % 50}/m${i}.ts`;
    const entries = Array.from({ length: N }, (_, i) => ({ name: 'helper', file: file(i), scope: `C${i}`, kind: 'method' }));
    (scanner as any).symbolIndex = new Map([['helper', entries]]);
    const fileMap = new Map(entries.map((e) => [e.file, 'repo1']));
    const resolve = (from: string) => (scanner as any).resolveSymbolToFile('helper', fileMap, from) as string | null;

    // A caller declaring none gets the candidate sharing most leading directories, then the first by path.
    const firstInDir = new Map<string, string>();
    for (const e of entries) {
      const dir = e.file.slice(0, e.file.lastIndexOf('/'));
      if (!firstInDir.has(dir) || e.file < firstInDir.get(dir)!) firstInDir.set(dir, e.file);
    }

    const own = Array.from({ length: N }, (_, i) => file(i));
    const callers = Array.from({ length: N }, (_, i) => `src/d${i % 50}/sub/caller${i}.ts`);
    const started = performance.now();
    const ownAnswers = own.map(resolve);
    const callerAnswers = callers.map(resolve);
    const seconds = (performance.now() - started) / 1000;
    expect(ownAnswers).toEqual(own); // the caller's own declaration
    expect(callerAnswers).toEqual(callers.map((_, i) => firstInDir.get(`src/d${i % 50}`)));
    // 0.6 s alone and about 4 s under the full suite's load; the per-call filtering before M4-03 took 876 s.
    expect(seconds).toBeLessThan(20);
  }, 600000);
});

describe('nearestIndex', () => {
  it('returns exactly closest(files, source) for random path sets (2,000 cases)', () => {
    // mulberry32: deterministic, and its low bits vary (a power-of-two LCG's cycle and made every case trivial).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };
    const segs = ['src', 'app', 'lib', 'a', 'b', 'Http', 'http', ''];
    const path = () => [...Array.from({ length: rand(5) }, () => segs[rand(segs.length)]), `f${rand(6)}.ts`].join('/');
    let nontrivial = 0;
    for (let c = 0; c < 2000; c++) {
      const files = [...new Set(Array.from({ length: 1 + rand(30) }, path))].sort();
      const source = path();
      const expected = closest(files, source);
      if (expected !== files[0]) nontrivial++;
      expect(nearestIndex(files)(source), `${source} in ${files.join(', ')}`).toBe(expected);
    }
    // Many cases pick a file other than the first: the prefix walk is what decides them.
    expect(nontrivial).toBeGreaterThan(500); // 946 with this seed
  });
});

describe('resume state (real scan, in process)', () => {
  const N = 1500;
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-resume-'));
    // Fixed-width paths: every batch of 100 files writes the same number of bytes.
    for (let i = 0; i < N; i++) {
      const dir = join(root, 'src', `d${String(i % 10).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      const next = (i + 1) % N;
      writeFileSync(join(dir, `m${String(i).padStart(4, '0')}.ts`),
        `import { f${next} } from '../d${String(next % 10).padStart(2, '0')}/m${String(next).padStart(4, '0')}';\nexport function f${i}() { return f${next}(); }\n`);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const edgesOf = (store: Store) => store.getAllEdges()
    .map((e) => `${e.source_file} ${e.source_symbol} ${e.target_file} ${e.target_symbol} ${e.edge_type}`).sort();
  const newScanner = async (store: Store, onProgress?: ConstructorParameters<typeof Scanner>[3]) => {
    const config = await Config.load(root);
    return { scanner: new Scanner(store, config, new MapxGraph(config.repos[0]!.name), onProgress), repo: config.repos[0]!.name };
  };

  it('writes a constant amount per batch, and the batch records are deleted when the scan completes', async () => {
    const store = new Store(':memory:');
    const writes: { key: string; bytes: number }[] = [];
    const setMeta = store.setMeta.bind(store);
    store.setMeta = (key: string, value: string) => {
      if (key.startsWith('scan_resume_')) writes.push({ key, bytes: value.length });
      setMeta(key, value);
    };
    const { scanner, repo } = await newScanner(store);
    await scanner.scanFull();

    const batches = writes.filter((w) => w.key.startsWith('scan_resume_batch:'));
    expect(batches.map((w) => w.key)).toEqual(Array.from({ length: N / 100 }, (_, k) => `scan_resume_batch:${k}:${repo}`));
    const sizes = batches.map((w) => w.bytes);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThanOrEqual(1.1);
    expect(Math.max(...sizes)).toBeLessThan(4096);
    // The header is written when parsing starts and cleared at the end, never per batch.
    expect(writes.filter((w) => w.key === `scan_resume_state:${repo}` && w.bytes > 0)).toHaveLength(1);
    expect(store.getMeta(`scan_resume_state:${repo}`)).toBe('');
    expect(store.getMeta(`scan_resume_batch:0:${repo}`)).toBeNull();
  }, 300000);

  it('clears every batch record the header allows, past a gap left by an earlier interrupted clear (review 2026-11-01)', async () => {
    const store = new Store(':memory:');
    const { scanner, repo } = await newScanner(store);
    store.setMeta(`scan_resume_state:${repo}`, JSON.stringify({ totalFiles: 1000, completedFiles: [], totalSymbols: 0, totalEdges: 0 }));
    for (const k of [5, 6, 7, 8, 9]) store.setMeta(`scan_resume_batch:${k}:${repo}`, JSON.stringify({ completedFiles: [`old${k}.ts`], totalSymbols: 1, totalEdges: 1 }));
    (scanner as any).saveResumeState(repo, { totalFiles: 1000, completedFiles: [], totalSymbols: 0, totalEdges: 0 });
    for (const k of [5, 6, 7, 8, 9]) expect(store.getMeta(`scan_resume_batch:${k}:${repo}`)).toBeNull();
    (scanner as any).saveResumeBatch(repo, 0, { completedFiles: ['new.ts'], totalSymbols: 2, totalEdges: 3 });
    expect((scanner as any).loadResumeState(repo)).toMatchObject({ completedFiles: ['new.ts'], totalSymbols: 2, totalEdges: 3 });
  });

  it('does not keep the symbol index or its memo after a scan', async () => {
    const { scanner } = await newScanner(new Store(':memory:'));
    await scanner.scanFull();
    expect((scanner as any).symbolIndex).toBeNull();
    expect((scanner as any).nameCandidatesFor).toBeNull();
    expect((scanner as any).nameCandidates.size).toBe(0);
  }, 300000);

  it('resumes an aborted scan without reparsing completed files and ends with the edges of a fresh scan', async () => {
    const store = new Store(':memory:');
    let scanner!: Scanner;
    const first = await newScanner(store, (p) => {
      if (p.phase === 'resolve' && p.current >= 300) scanner.abort();
    });
    scanner = first.scanner;
    const interrupted = await scanner.scanFull();
    expect(interrupted.interrupted).toBe(true);

    const state = (scanner as any).loadResumeState(first.repo) as { completedFiles: string[]; totalEdges: number };
    expect(state.completedFiles).toHaveLength(300);
    expect(new Set(state.completedFiles).size).toBe(300);

    const indexed: number[] = [];
    const second = await newScanner(store, (p) => {
      if (p.phase === 'index' && p.current === 0) indexed.push(p.total);
    });
    const resumed = await second.scanner.scanFull();
    expect(resumed.interrupted).toBeFalsy();
    expect(indexed).toEqual([N - 300]);
    expect(store.getMeta(`scan_resume_batch:0:${first.repo}`)).toBeNull();

    const fresh = new Store(':memory:');
    await (await newScanner(fresh)).scanner.scanFull();
    expect(edgesOf(store)).toEqual(edgesOf(fresh));
    expect(edgesOf(store)).toHaveLength(2 * N); // one import and one call edge per file
  }, 300000);
});
