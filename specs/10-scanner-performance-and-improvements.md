# MapX Scanner: Performance Analysis & Improvement Roadmap

> **Scope**: Deep analysis of `src/core/scanner.ts` (1472 lines), `src/parsers/parse-worker.ts`, `src/parsers/parser-registry.ts`, `src/parsers/wasm-parser.ts`, and the post-scan analysis pipeline. All findings are grounded in source code review and live MCP tool observations on 2026-06-01.

---

## 1. Scanner Architecture Overview

The scanner is the central orchestrator of the MapX index-building pipeline. It consists of two scan modes:

```
mapx scan  →  Scanner::scan()
               └─ acquireScanLock
               └─ _scanFullForRepo (per repo)
                   ├─ discoverFiles           [walk + hash every file]
                   ├─ parseFilesParallel      [WASM tree-sitter parse, bounded concurrency]
                   │   └─ parseOnMainThread
                   ├─ writeParseResult x N    [symbol + edge DB writes, batched]
                   ├─ resolveReferencesWithMap x N  [symbol→file resolution per file]
                   ├─ scanFrameworkRoutesAndHooks   [detector pass + file reads again]
                   ├─ CodebaseProfiler::profile
                   ├─ RoleClassifier (per file)
                   ├─ ClusterEngine::detect
                   ├─ calculateClusterMetrics
                   └─ ArchitectureAnalyzer::analyze

mapx sync  →  Scanner::scanIncremental()
               └─ _scanIncrementalForRepo
                   ├─ getChangedFiles (git diff)
                   └─ same parse/write/resolve pipeline (changed files only)
```

The codebase scanned here: **226 files, 1053 symbols, 1324 edges** in approximately 674ms on an incremental run. A full cold scan of a larger monorepo would exhibit all the issues described below more severely.

---

## 2. Issue 1: Every File Is Read From Disk Twice

**Location**: `Scanner::discoverFiles` + `Scanner::parseOnMainThread`  
**Severity**: HIGH for large codebases

### What happens

`discoverFiles` reads every file to compute its content hash and line count:

```typescript
// discoverFiles — line ~835
const content = await readFile(fullPath, 'utf-8');
const stats = await stat(fullPath);
const lines = content.split('\n').length;
const contentHash = createHash('md5').update(content).digest('hex');
// content is discarded after this
```

Later, `parseOnMainThread` reads every file to parse again:

```typescript
// parseOnMainThread — line ~905
const sources = await Promise.all(
  files.map(async (f) => {
    return await readFile(f.absolutePath, 'utf-8');
  }),
);
```

For a codebase with 500 files averaging 10 KB each, this is **10 MB of redundant I/O** per scan. On cold NVMe this is negligible, but on remote filesystems, network mounts, or mechanical drives, the double-read creates significant latency.

### Fix

Cache file content in `DiscoveredFile` at discovery time and pass it into the parse pipeline:

```typescript
interface DiscoveredFile extends FileInfo {
  // ...existing fields...
  contentHash: string;
  content: string;        // ← ADD: cache at discovery time
  isNew: boolean;
  contentChanged: boolean;
}
```

In `discoverFiles`, retain content in the struct. In `parseOnMainThread`, accept optional pre-read content and skip the `readFile` call if already present. This collapses two I/O passes into one across the entire scan.

---

## 3. Issue 2: `discoverFiles` Walk Is Fully Sequential

**Location**: `Scanner::discoverFiles`, the `walk` async function  
**Severity**: MEDIUM

### What happens

The recursive `walk` function processes directory entries sequentially:

```typescript
const walk = async (currentDir: string) => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {          // ← sequential loop
    if (entry.isDirectory()) {
      await walk(fullPath);               // ← await each subdirectory serially
    } else if (entry.isFile()) {
      const content = await readFile(fullPath, 'utf-8');  // ← await per file
      const stats = await stat(fullPath);                 // ← second await per file
      // ...
    }
  }
};
```

Each subdirectory blocks the event loop for itself before sibling directories are explored. Each file performs two sequential awaits (`readFile` + `stat`). For a project with deep directory trees, this serialises what is fundamentally a parallelisable I/O operation.

### Fix

```typescript
const walk = async (currentDir: string) => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const dirEntries = entries.filter(e => e.isDirectory());
  const fileEntries = entries.filter(e => e.isFile());

  // 1. Process all files in this directory concurrently
  await Promise.all(fileEntries.map(async (entry) => {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
    if (!matcher(relPath)) return;
    const langDef = getLanguageForFile(fullPath, ...);
    if (!langDef) return;
    // Merge readFile + stat into a single stat+read without separate stat()
    const [content, stats] = await Promise.all([
      readFile(fullPath, 'utf-8'),
      stat(fullPath),
    ]);
    // ... push to files[]
  }));

  // 2. Recurse into subdirectories concurrently (bounded)
  await Promise.all(dirEntries.map(async (entry) => {
    if (DEFAULT_IGNORE.has(entry.name)) return;
    await walk(join(currentDir, entry.name));
  }));
};
```

This parallelises both file reads within a directory and subdirectory traversal. Use a semaphore (e.g. p-limit) to bound concurrency if the directory tree is very deep.

**Additional micro-optimisation**: Replace the two syscalls `readFile` + `stat` with a single `readFile` call (since `stat.size` can be derived from `Buffer.byteLength(content)` and `lines` from `content.split('\n').length`), reducing per-file syscall count from 2 to 1.

---

## 4. Issue 3: No True Worker Thread Parallelism

**Location**: `Scanner::parseFilesParallel`, `Scanner::parseWithWorkers`, `Scanner::parseOnMainThread`  
**Severity**: HIGH for CPU-bound parse workloads

### What happens

The scanner has infrastructure suggesting worker-thread support (`DEFAULT_CONCURRENCY`, `parseWithWorkers`, `parse-worker.ts`) but all three methods converge to the same single-threaded implementation:

```typescript
// parseFilesParallel — line 871
private async parseFilesParallel(...): Promise<ParseResult[]> {
  if (files.length === 0) return [];
  return this.parseOnMainThread(...);   // ← always goes here
}

// parseWithWorkers — line 881
private async parseWithWorkers(...): Promise<ParseResult[]> {
  return this.parseOnMainThread(...);   // ← also always goes here
}
```

The concurrency in `parseOnMainThread` is interleaving-based, not CPU-parallel:

```typescript
const runWorker = async () => {
  while (!this.aborted) {
    const i = nextIdx++;
    // ... await parser.parse() which yields around WASM I/O
    await new Promise(resolve => setImmediate(resolve));  // cooperative yield
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, runWorker));
```

The `CONCURRENCY` cap (`min(cpus, 8)`) creates `N` cooperative coroutines sharing the same JavaScript event loop and the same WASM linear memory. Since web-tree-sitter parses are CPU-bound (they walk the AST and execute query matching inside WASM), multiple concurrent parses on the main thread do not benefit from multiple CPU cores.

**Observation from `wasm-parser.ts`**: A new `Parser` instance is created per `parseWithQueries` invocation ("to avoid language-switching races"), adding WASM object instantiation overhead for every single file.

### Fix Option A: True Worker Threads (high impact, more complex)

`parse-worker.ts` already exists as a skeleton. Wire it up:

1. Spawn `min(cpus, 8)` worker threads at scanner startup using `node:worker_threads`
2. Each worker loads the WASM grammar once and maintains its parser instances
3. Main thread distributes `{ filePath, source, language }` jobs over a shared job queue (e.g. `MessageChannel` or a simple index counter on a SharedArrayBuffer)
4. Workers post back `ParseResult[]`

This distributes WASM CPU work across physical cores. On an 8-core machine parsing 500 TypeScript files, expected speedup: 3–5× over single-threaded.

### Fix Option B: WASM Shared Buffer (medium impact, simpler)

Keep single-threaded but eliminate per-parse `new Parser()` overhead by maintaining one parser per language per process:

```typescript
// wasm-parser.ts
const parserPool = new Map<string, Parser>();  // language → reused parser

export async function parseWithQueries(source, language, symQ, refQ) {
  await ensureInit();
  let parser = parserPool.get(language.name);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserPool.set(language.name, parser);
  }
  // parser.parse() is synchronous inside tree-sitter; no race if single-threaded
  const tree = parser.parse(source);
  // ...
}
```

This eliminates the `new Parser()` allocation per file while remaining safe in the single-threaded event loop.

---

## 5. Issue 4: O(N×M) Symbol Resolution via Per-Reference DB Queries

**Location**: `Scanner::resolveReferencesWithMap`, `Scanner::resolveSymbolToFile`  
**Severity**: HIGH for large files with many references

### What happens

For every **non-import, non-require** reference (call, instantiation, extends, implements), `resolveSymbolToFile` issues a database query:

```typescript
private resolveSymbolToFile(symbolName: string, ...): string | null {
  // ...
  let matches = this.store.searchSymbols(symbolName);   // ← DB query per reference
  // ...
}
```

In `resolveReferencesWithMap`, this is called in a tight loop:

```typescript
for (const ref of refs) {
  if (ref.referenceType === 'require') { ... }
  else if (ref.referenceType === 'import') { ... }
  else {
    targetFile = this.resolveSymbolToFile(ref.targetName, ...);  // ← per ref
  }
}
```

For `src/cli.ts` (26 functions, ~200+ references), this issues approximately **150–200 SQLite queries** just for `cli.ts` symbol resolution. Across a 500-file TypeScript codebase, this could mean **50,000–100,000** individual DB lookups.

The `store.searchSymbols` method is a `LIKE '%name%'` query or an index lookup — even if fast (sub-millisecond), at 100K invocations this adds 10–100 seconds of serial DB time during a full scan.

### Fix: Build a Pre-Scan Symbol Name Index

Before the reference resolution loop, build a single in-memory index from the DB:

```typescript
// Build once before resolveReferencesWithMap is called for a batch
private buildSymbolIndex(repoName: string): Map<string, string[]> {
  const allSymbols = this.store.getAllSymbols(repoName);
  const index = new Map<string, string[]>();
  for (const sym of allSymbols) {
    const existing = index.get(sym.name) ?? [];
    existing.push(sym.file_path);
    index.set(sym.name, existing);
  }
  return index;
}
```

Pass this index into `resolveReferencesWithMap` and replace the per-reference `store.searchSymbols(name)` call with a `Map.get(name)` lookup. For 1053 symbols, building the index costs one DB round-trip; every subsequent lookup is O(1) in-memory.

This single change would reduce symbol resolution from ~N×M DB queries to 1 DB query + N×M Map lookups.

---

## 6. Issue 5: `detectActiveFrameworks` Called Twice Per Full Scan

**Location**: `Scanner::_scanFullForRepo` (line ~318) and `Scanner::scanFrameworkRoutesAndHooks` (line ~1350)  
**Severity**: MEDIUM

### What happens

```typescript
// First call — _scanFullForRepo
const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
const activeFrameworks = activeDetectors.map(d => d.name);
const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);
// ... parsing proceeds ...

// Second call — scanFrameworkRoutesAndHooks (called later in the same scan)
const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
```

`detectActiveFrameworks` reads `package.json`, `composer.json`, `pubspec.yaml`, and other manifest files per-detector to determine which frameworks are active. This is repeated in full for every scan, and called twice within a single full scan.

### Fix

Cache the result in the `Scanner` instance for the lifetime of a single scan:

```typescript
private cachedActiveDetectors: Map<string, FrameworkDetector[]> = new Map();

private async getActiveDetectors(repoRoot: string, filePaths: string[]): Promise<FrameworkDetector[]> {
  if (this.cachedActiveDetectors.has(repoRoot)) {
    return this.cachedActiveDetectors.get(repoRoot)!;
  }
  const detectors = await FrameworkRegistry.getInstance().detectActiveFrameworks(repoRoot, filePaths);
  this.cachedActiveDetectors.set(repoRoot, detectors);
  return detectors;
}
```

Clear `cachedActiveDetectors` at the start of each scan call.

---

## 7. Issue 6: Post-Scan Analysis Pipeline Is Sequential and Blocking

**Location**: `Scanner::_scanFullForRepo` lines ~390–475  
**Severity**: MEDIUM for large codebases

### What happens

After all files are parsed and written to DB, the scanner runs five sequential analysis passes:

```typescript
// 1. Framework route/hook scan (reads files from disk again)
await this.scanFrameworkRoutesAndHooks(repo, repoRoot);

// 2. Codebase profiling
const profiler = new CodebaseProfiler(this.store);
const profile = profiler.profile(repo.name, activeFrameworks);

// 3. File role classification (iterates ALL files, classifies each)
const classifier = new RoleClassifier(this.store, this.config);
const files = this.store.getAllFiles(repo.name);
this.store.inTransaction(() => {
  for (const f of files) {
    const result = classifier.classify(filePath, ...);
    // ...
  }
});

// 4. Cluster detection (Leiden community algorithm)
const clusterEngine = new ClusterEngine(this.store);
clusterEngine.detect(repo.name);

// 5. Cluster metrics
const metricsList = calculateClusterMetrics(this.store, repo.name);

// 6. Architecture smell detection
const analyzer = new ArchitectureAnalyzer(this.store);
const smellsList = analyzer.analyze(repo.name, profile);
```

Several of these can run concurrently because they read from the DB but do not depend on each other's output (after profile is computed):

- Steps 2 and 1 share no dependency
- Step 3 depends on step 1 (needs route/hook info for classification) and step 2 (needs profile)
- Steps 4, 5, 6 depend on step 3 completing

### Fix: Parallelise Steps 1 & 2, Then Steps 4/5/6

```typescript
// Run framework scan and profiling concurrently
const [, profile] = await Promise.all([
  this.scanFrameworkRoutesAndHooks(repo, repoRoot),
  Promise.resolve(new CodebaseProfiler(this.store).profile(repo.name, activeFrameworks)),
]);

// Classify files after both complete
await this.classifyFiles(repo, profile);

// Run cluster, metrics, smells concurrently
await Promise.all([
  clusterEngine.detect(repo.name),
  // metrics and smells can start after cluster if they depend on cluster data,
  // or concurrently if they only need raw graph
]);
```

On large codebases, the framework route scan (which re-reads files) and the profiler (which queries the DB) are the two most expensive post-parse steps; overlapping them can save 1–3 seconds.

---

## 8. Issue 7: `discoverDartPackages` Reads Full File Table

**Location**: `Scanner::discoverDartPackages` (line ~1186)  
**Severity**: LOW (only affects Dart projects)

### What happens

```typescript
private discoverDartPackages(workspaceRoot: string): void {
  this.dartPackageMap.clear();
  const allFiles = this.store.getAllFiles();   // ← full table scan
  for (const f of allFiles) {
    const filePath = f.path as string;
    if (!filePath.endsWith('pubspec.yaml')) continue;
    // ...
  }
}
```

`store.getAllFiles()` returns all files across all repos. For a 500-file project, this loads 500 rows just to find 1–2 `pubspec.yaml` files.

### Fix

Add a filtered query to the Store interface:

```typescript
// store.ts
getFilesByPattern(pattern: string, repo?: string): FileRow[] {
  return this.raw.prepare(
    `SELECT * FROM files WHERE path LIKE ? ${repo ? 'AND repo = ?' : ''}`
  ).all(`%${pattern}%`, ...(repo ? [repo] : [])) as FileRow[];
}
```

Then `discoverDartPackages` becomes:

```typescript
const pubspecFiles = this.store.getFilesByPattern('pubspec.yaml');
```

---

## 9. Issue 8: `workspaceFileMap` Rebuilt Multiple Times Per Scan

**Location**: `Scanner::resolveReferences`, `Scanner::writeParseResult`  
**Severity**: LOW-MEDIUM

### What happens

`workspaceFileMap` is a `Map<relativePath, repoName>` used to resolve cross-file symbol references. It is populated at the start of each scan run. However, there are two fallback paths that rebuild it from the database:

```typescript
// resolveReferences — fallback
private resolveReferences(...): GraphEdge[] {
  if (this.workspaceFileMap.size === 0) {
    for (const f of this.store.getAllFiles()) {
      this.workspaceFileMap.set(...);   // ← full DB rebuild if empty
    }
  }
  // ...
}

// writeParseResult — also rebuilds
private writeParseResult(...): void {
  if (this.workspaceFileMap.size === 0) {
    for (const f of this.store.getAllFiles()) {
      this.workspaceFileMap.set(...);
    }
  }
  // ...
}
```

The primary code path in `_scanFullForRepo` builds `workspaceFileMap` once before the batch loop (for the `resolveReferencesWithMap` call), so these fallbacks should not normally trigger. However, the secondary path `writeParseResult` (which is also called from `_scanIncrementalForRepo`) can trigger a DB rebuild for each incremental file if the map was cleared.

### Fix

Ensure `workspaceFileMap` is guaranteed populated before any parse/write operation. Consider making it lazy-init at construction time for the primary repo or moving the population to `acquireScanLock`.

---

## 10. Issue 9: Resume State Saved at Every 100-File Batch

**Location**: `Scanner::_scanFullForRepo`, the batch loop  
**Severity**: LOW

### What happens

```typescript
const BATCH_SIZE = 100;
for (let batchStart = 0; batchStart < toParse.length && !this.aborted; batchStart += BATCH_SIZE) {
  // ... write symbols/edges to DB in a transaction ...
  this.saveResumeState(repo.name, {
    totalFiles: discovered.length,
    completedFiles: [...completed],   // ← spread entire set each time
    totalSymbols,
    totalEdges,
  });
}
```

`completedFiles: [...completed]` spreads the entire `Set<string>` into an array and serialises it to JSON on every batch. For a 1000-file project with BATCH_SIZE=100, this writes a JSON payload that grows from 100 to 1000 strings across 10 iterations — total serialised bytes grow as O(N²) across batches.

### Fix

- Store only the `batchStart` index rather than the full file list (index into the sorted `toParse` array)
- Or use a delta approach: record only newly completed files in this batch and merge at resume time

---

## 11. Incremental Scan: Git Dependency Limits Non-Git Projects

**Location**: `Scanner::_scanIncrementalForRepo` (line ~548)  
**Severity**: MEDIUM for non-git workflows

### What happens

```typescript
if (!isGitRepo(repoRoot)) {
  return this._scanFullForRepo(repo);  // ← falls back to full scan
}
const changes = getChangedFiles(repoRoot, lastCommit || undefined);
```

Any project not using git cannot benefit from incremental scanning — every `mapx sync` triggers a full scan. For CI pipelines, monorepo setups without `.git` at the sub-project level, or non-git VCS (Mercurial, SVN), this completely defeats the `sync` performance model.

### Fix: Content-Hash-Based Incremental Fallback

When `isGitRepo` is false, use the stored content hashes from `discoverFiles` to compute the diff:

```typescript
const changedFiles = discovered.filter(f => f.contentChanged || f.isNew);
```

This is already computed in `discoverFiles` — the hash comparison logic exists. The incremental path just needs to use it instead of immediately falling back to full scan.

---

## 12. Performance Profiling Reference

The table below consolidates estimated impact per issue based on a hypothetical 1000-file TypeScript monorepo:

| Issue | Phase | Estimated Overhead | Fix Complexity |
|---|---|---|---|
| Double file reads (§2) | discover + parse | ~15–30% of I/O time | Low |
| Sequential directory walk (§3) | discover | ~10–20% on deep trees | Medium |
| No worker thread parallelism (§4) | parse | ~50–70% of CPU parse time | High |
| Per-reference DB queries (§5) | resolve | ~20–40% of post-parse time | Medium |
| Duplicate framework detection (§6) | framework scan | ~5–10% | Low |
| Sequential post-scan pipeline (§7) | post-parse | ~15–25% of total scan | Medium |
| Full file table for Dart discovery (§8) | post-parse | Negligible except for large repos | Low |
| Resume state JSON growth (§10) | batch write | Negligible (scan time), notable (DB write) | Low |
| Non-git full scan fallback (§11) | incremental | Full scan overhead on every sync | Medium |

### Highest-Leverage Changes (ordered by ROI)

1. **True worker thread parallelism** (§4) — parses are CPU-bound WASM; only actual threads will help  
2. **Pre-scan symbol index** (§5) — O(N×M) DB queries → O(1) Map lookups per reference  
3. **Content cached in `DiscoveredFile`** (§2) — eliminates double file reads  
4. **Parallel directory walk** (§3) — I/O parallelism across directories  
5. **Content-hash incremental for non-git** (§11) — enables `sync` to work on all projects  
6. **Parallel post-scan steps** (§7) — overlaps framework scan + profiler  
7. **Framework detection cache** (§6) — trivial 2-line fix for duplicate detection  

---

## 13. Appendix: Scan Timing Breakdown (Observed)

From a full incremental scan of the mapx codebase (226 files, current state):

```
Scanned 226 files in /Users/gamil/Projects/mapx (674ms)
Found 115 symbols, 296 edges in changed files
```

Note: the 674ms figure covers only the parse phase of changed/new files. The full scan including framework detection, profiling, classification, clustering, and architecture analysis is not broken out in the current output. **Adding per-phase timing to scan output** would be a low-effort improvement that makes performance regressions immediately visible.

---

## 14. Appendix: `parse-worker.ts` — The Dormant Worker

`src/parsers/parse-worker.ts` contains a complete worker thread implementation (language loading, query compilation, file parsing, result posting) with `parentPort.on('message', ...)` message handling. It is imported into the project and included in the build, but **the main thread never spawns it as a `Worker`**.

The `parseWithWorkers` method in `scanner.ts` calls `parseOnMainThread` unconditionally. The `parse-worker.ts` file exists as infrastructure for a future worker-thread implementation but was deactivated (likely due to WASM initialisation complexity in worker threads). The correct approach is to use `workerData` to pass the WASM path and language definitions to each worker at spawn time, which the file already supports via `langDefs` and `assetRoot` at the top of the module.

Activating this dormant implementation is the single highest-impact scanner improvement available.
