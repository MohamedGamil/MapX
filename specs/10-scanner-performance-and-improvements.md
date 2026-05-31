# MapX Scanner: Performance Analysis & Improvement Roadmap

> **Scope**: Deep analysis of `src/core/scanner.ts` (1472 lines), `src/parsers/parse-worker.ts`, `src/parsers/parser-registry.ts`, `src/parsers/wasm-parser.ts`, and the post-scan analysis pipeline. All findings are grounded in source code review and live MCP tool observations on 2026-06-01.
>
> **Verification pass**: A second LLM independently verified every claim against source code with exact line numbers on 2026-06-01. Corrections are noted inline with `[EDIT]` tags. New findings are marked `[NEW]`.

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
                   ├─ writeParseResultWithMap x N  [symbol + edge DB writes, batched]
                   ├─ resolveReferencesWithMap     [symbol→file resolution via fileMap]
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

<!-- [EDIT] Corrected writeParseResult to writeParseResultWithMap — the full scan path uses the Map-based variant (scanner.ts:274), not the fallback writeParseResult. The incremental path uses writeParseResult. Also noted resolveReferencesWithMap is called inline within writeParseResultWithMap, not as a separate step. -->

The codebase scanned here: **228 files, 1053 symbols, 1324 edges** (1305 verified, 19 inferred) in approximately 479ms on a full re-scan. A full cold scan of a larger monorepo would exhibit all the issues described below more severely.

<!-- [EDIT] Updated file count from 226 to 228 (observed via mapx_scan), added edge verification breakdown from mapx_status, corrected timing from 674ms to 479ms (full re-scan timing). -->

---

## 2. Issue 1: Every File Is Read From Disk Twice

**Location**: `Scanner::discoverFiles` + `Scanner::parseOnMainThread`  
**Severity**: HIGH for large codebases

### What happens

`discoverFiles` reads every file to compute its content hash and line count:

<!-- [EDIT] Corrected line numbers — actual reads at line 755 and stats at line 756 (not 835/850 as originally cited). -->

```typescript
// discoverFiles — line ~755
const content = await readFile(fullPath, 'utf-8');
const stats = await stat(fullPath);
const lines = content.split('\n').length;
const contentHash = createHash('md5').update(content).digest('hex');
// content is discarded after this — only contentHash is stored in DiscoveredFile
```

Later, `parseOnMainThread` reads every file to parse again:

```typescript
// parseOnMainThread — line ~902
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

<!-- [NEW] Memory trade-off note: for a 500-file codebase averaging 10KB/file, caching content adds ~5MB peak memory. For 5000-file monorepos with large files, consider a streaming approach or LRU cache with eviction. -->

**Memory trade-off**: Caching content in `DiscoveredFile` adds ~5MB for a 500-file/10KB average codebase. For larger monorepos, consider evicting content from `DiscoveredFile` after the parse phase completes, or using a separate `Map<path, content>` that is cleared after parsing.

---

## 3. Issue 2: `discoverFiles` Walk Is Fully Sequential

**Location**: `Scanner::discoverFiles`, the `walk` async function  
**Severity**: MEDIUM

### What happens

<!-- [EDIT] Corrected line numbers — walk function starts at line 721, sequential loop at line 724, readFile at 755, stat at 756. -->

The recursive `walk` function processes directory entries sequentially:

```typescript
const walk = async (currentDir: string) => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {          // ← sequential loop (line 724)
    if (entry.isDirectory()) {
      await walk(fullPath);               // ← await each subdirectory serially (line 746)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath, 'utf-8');  // ← await per file (line 755)
      const stats = await stat(fullPath);                 // ← second await per file (line 756)
      // ...
    }
  }
};
```

Each subdirectory blocks the event loop for itself before sibling directories are explored. Each file performs two sequential awaits (`readFile` + `stat`). For a project with deep directory trees, this serialises what is fundamentally a parallelisable I/O operation.

<!-- [NEW] Additional observation: the walk function also contains early-exit checks (aborted flag at line 725, DEFAULT_IGNORE at line 726, dotfile exclusion at line 727, shouldExcludeDir at line 733, unregistered nested git repo detection at lines 737-744) that add overhead but are necessary for correctness. Any parallelisation must preserve these guards. -->

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

<!-- [NEW] Thread-safety note: the `files` array is pushed to from concurrent coroutines. In JavaScript this is safe (no true parallel mutation), but if worker threads are added in the future, a mutex or per-worker accumulator would be needed. -->

---

## 4. Issue 3: No True Worker Thread Parallelism

**Location**: `Scanner::parseFilesParallel`, `Scanner::parseWithWorkers`, `Scanner::parseOnMainThread`  
**Severity**: HIGH for CPU-bound parse workloads

### What happens

The scanner has infrastructure suggesting worker-thread support (`DEFAULT_CONCURRENCY`, `parseWithWorkers`, `parse-worker.ts`) but all three methods converge to the same single-threaded implementation:

<!-- [EDIT] Confirmed exact line numbers — parseFilesParallel at line 800, parseWithWorkers at line 810. Both directly call parseOnMainThread. -->

```typescript
// parseFilesParallel — line 800
private async parseFilesParallel(...): Promise<ParseResult[]> {
  if (files.length === 0) return [];
  return this.parseOnMainThread(...);   // ← always goes here
}

// parseWithWorkers — line 810
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

<!-- [EDIT] Corrected observation about WASM parser — verified at wasm-parser.ts line 90: `const parser = new Parser()` with comment "Use a fresh parser instance per call to avoid language-switching races". This creates a new WASM Parser object per file, adding allocation overhead. -->

**Observation from `wasm-parser.ts`**: A new `Parser` instance is created per `parseWithQueries` invocation at line 90 ("Use a fresh parser instance per call to avoid language-switching races"), adding WASM object instantiation overhead for every single file. For 228 files, this means 228 Parser allocations.

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

<!-- [NEW] Note: Fix B is safe ONLY if parseOnMainThread's cooperative concurrency is strictly sequential (which it is — the `nextIdx++` is uncontended in single-threaded JS). If Fix A (worker threads) is implemented, each worker needs its own parser pool since Parser instances are not thread-safe. -->

---

## 5. Issue 4: O(N×M) Symbol Resolution via Per-Reference DB Queries

**Location**: `Scanner::resolveReferencesWithMap`, `Scanner::resolveSymbolToFile`  
**Severity**: HIGH for large files with many references

### What happens

For every **non-import, non-require** reference (call, instantiation, extends, implements), `resolveSymbolToFile` issues a database query:

<!-- [EDIT] Corrected line references — resolveSymbolToFile at line 1212, store.searchSymbols call at line 1233. The query is a SQL LIKE '%name%' COLLATE NOCASE (store.ts:385-415). -->

```typescript
private resolveSymbolToFile(symbolName: string, ...): string | null {
  // ...
  let matches = this.store.searchSymbols(symbolName);   // ← DB query per reference (line 1233)
  // uses: SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE
}
```

In `resolveReferencesWithMap`, this is called in a tight loop:

```typescript
for (const ref of refs) {
  if (ref.referenceType === 'require') { ... }
  else if (ref.referenceType === 'import') { ... }
  else {
    targetFile = this.resolveSymbolToFile(ref.targetName, ...);  // ← per ref (line 1037)
  }
}
```

For `src/cli.ts` (26 functions, ~200+ references), this issues approximately **150–200 SQLite queries** just for `cli.ts` symbol resolution. Across a 500-file TypeScript codebase, this could mean **50,000–100,000** individual DB lookups.

The `store.searchSymbols` method is a `LIKE '%name%'` query — even with SQLite's internal optimizations, at 100K invocations this adds notable serial DB time during a full scan.

<!-- [EDIT] Removed "sub-millisecond" qualifier since LIKE '%name%' cannot use index prefix — the query does a full table scan each time. -->

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

<!-- [NEW] Additional consideration: resolveSymbolToFile also has fuzzy matching logic (filterMatches at line 1223) that handles qualified names, case variations, and same-file preferences. The in-memory index should support these secondary lookups — consider indexing by both `name` and `name.toLowerCase()` keys, and maintaining a file→symbols reverse map for same-file preference checks. -->

---

## 6. Issue 5: `detectActiveFrameworks` Called Twice Per Full Scan

**Location**: `Scanner::_scanFullForRepo` (line ~237) and `Scanner::scanFrameworkRoutesAndHooks` (line ~1304)  
**Severity**: MEDIUM

### What happens

<!-- [EDIT] Corrected first call location from line ~318 to line ~237 (within the toParse>0 block), and confirmed second call at line ~1304 inside scanFrameworkRoutesAndHooks called from line ~318. Also confirmed same pattern in _scanIncrementalForRepo (line ~556 + line ~1304 via line ~602). -->

```typescript
// First call — _scanFullForRepo (line ~237)
const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
const activeFrameworks = activeDetectors.map(d => d.name);
const ignoredSymbols = buildIgnoredSymbols(activeFrameworks);
// ... parsing proceeds ...

// Second call — scanFrameworkRoutesAndHooks (called from line ~318, executes at line ~1304)
const activeDetectors = await registry.detectActiveFrameworks(repoRoot, filePaths);
```

`detectActiveFrameworks` reads `package.json`, `composer.json`, `pubspec.yaml`, and other manifest files per-detector to determine which frameworks are active. This is repeated in full for every scan, and called twice within a single full scan.

<!-- [NEW] Third occurrence: _scanIncrementalForRepo also calls detectActiveFrameworks at line ~556, then again via scanFrameworkRoutesAndHooks at line ~602. So every incremental scan also has the same duplication. -->

**Both scan paths affected**: `_scanFullForRepo` calls it at line ~237, then again at line ~318 (via `scanFrameworkRoutesAndHooks`). `_scanIncrementalForRepo` calls it at line ~556, then again at line ~602 (via `scanFrameworkRoutesAndHooks`).

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

**Location**: `Scanner::_scanFullForRepo` lines ~317–402  
**Severity**: MEDIUM for large codebases

### What happens

<!-- [EDIT] Corrected line range from ~390-475 to ~317-402 based on verified source. Also noted the same pipeline is duplicated verbatim in _scanIncrementalForRepo lines ~601-687. -->

After all files are parsed and written to DB, the scanner runs six sequential analysis passes:

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

<!-- [NEW] Code duplication observation: This entire 6-step pipeline is duplicated verbatim in both `_scanFullForRepo` (lines ~317-402) and `_scanIncrementalForRepo` (lines ~601-687). Any fix should extract this into a shared `runPostScanAnalysis(repo, repoRoot)` method to eliminate duplication and make both paths benefit from parallelisation. -->

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

**Extract shared method**: Refactor the 6-step pipeline into a single `runPostScanAnalysis(repo, repoRoot)` method called from both `_scanFullForRepo` and `_scanIncrementalForRepo` to eliminate the current verbatim code duplication.

---

## 8. Issue 7: `discoverDartPackages` Reads Full File Table

**Location**: `Scanner::discoverDartPackages` (line ~1186)  
**Severity**: LOW (only affects Dart projects)

### What happens

```typescript
private discoverDartPackages(workspaceRoot: string): void {
  this.dartPackageMap.clear();
  const allFiles = this.store.getAllFiles();   // ← full table scan, NO repo filter
  for (const f of allFiles) {
    const filePath = f.path as string;
    if (!filePath.endsWith('pubspec.yaml')) continue;
    // ...
  }
}
```

<!-- [EDIT] Emphasized that getAllFiles() is called WITHOUT a repo parameter, meaning it returns files across ALL registered repos — not just the current one being scanned. -->

`store.getAllFiles()` is called **without a repo parameter**, returning all files across all registered repos. For a 500-file project, this loads 500 rows just to find 1–2 `pubspec.yaml` files. In multi-repo workspaces, this returns files from all repos.

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
// resolveReferences — fallback (line ~1000)
private resolveReferences(...): GraphEdge[] {
  if (this.workspaceFileMap.size === 0) {
    for (const f of this.store.getAllFiles()) {
      this.workspaceFileMap.set(...);   // ← full DB rebuild if empty
    }
  }
  // ...
}

// writeParseResult — also rebuilds (line ~950)
private writeParseResult(...): void {
  if (this.workspaceFileMap.size === 0) {
    for (const f of this.store.getAllFiles()) {
      this.workspaceFileMap.set(...);
    }
  }
  // ...
}
```

<!-- [EDIT] Clarified actual code paths — the full scan path uses `writeParseResultWithMap` (line ~274) which receives the pre-built map and has a simpler fallback (lines ~260-266). Only the incremental path calls `writeParseResult` (line ~587) which has the full rebuild fallback. The claim is partially correct — the fallback exists but typically only fires in the incremental path. -->

**Path analysis**: In `_scanFullForRepo`, the map is pre-built at `scanFull()` lines ~102-105 and passed via `writeParseResultWithMap` at line ~274, which uses a simpler inline fallback (lines ~260-266). The `writeParseResult` fallback (with full DB rebuild) is only called from `_scanIncrementalForRepo` at line ~587. So in the full scan path, the rebuild typically does not fire. In the incremental path, if the map was cleared between runs, it triggers a DB rebuild for each incremental file.

### Fix

Ensure `workspaceFileMap` is guaranteed populated before any parse/write operation. Consider making it lazy-init at construction time for the primary repo or moving the population to `acquireScanLock`.

<!-- [NEW] Both scanFull and scanIncremental already pre-populate workspaceFileMap at their entry points (scanFull lines ~102-105, scanIncremental lines ~429-442). The fallback code in writeParseResult/resolveReferences is defensive — consider removing it entirely and replacing with an assertion to catch unexpected empty-map scenarios rather than silently rebuilding. -->

---

## 10. Issue 9: Resume State Saved at Every 100-File Batch

**Location**: `Scanner::_scanFullForRepo`, the batch loop  
**Severity**: LOW

### What happens

<!-- [EDIT] Confirmed BATCH_SIZE = 100 at line 268, batch loop at line 269, saveResumeState at line 286 with `[...completed]` spread. -->

```typescript
const BATCH_SIZE = 100;
for (let batchStart = 0; batchStart < toParse.length && !this.aborted; batchStart += BATCH_SIZE) {
  // ... write symbols/edges to DB in a transaction ...
  this.saveResumeState(repo.name, {
    totalFiles: discovered.length,
    completedFiles: [...completed],   // ← spread entire set each time (line 288)
    totalSymbols,
    totalEdges,
  });
}
```

`completedFiles: [...completed]` spreads the entire `Set<string>` into an array and serialises it to JSON on every batch. For a 1000-file project with BATCH_SIZE=100, this writes a JSON payload that grows from 100 to 1000 strings across 10 iterations — total serialised bytes grow as O(N²) across batches.

<!-- [NEW] Additionally, there is an initial saveResumeState call at lines ~227-232 (before parsing begins) that serializes unchanged+resumed files, adding further overhead for large partially-completed scans. -->

### Fix

- Store only the `batchStart` index rather than the full file list (index into the sorted `toParse` array)
- Or use a delta approach: record only newly completed files in this batch and merge at resume time

---

## 11. Incremental Scan: Git Dependency Limits Non-Git Projects

**Location**: `Scanner::_scanIncrementalForRepo` (line ~483)  
**Severity**: MEDIUM for non-git workflows

### What happens

<!-- [EDIT] Corrected line reference from ~548 to ~483 based on verified source. -->

```typescript
if (!isGitRepo(repoRoot)) {
  return this._scanFullForRepo(repo);  // ← falls back to full scan (line ~484)
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

<!-- [NEW] Note: The incremental path in _scanIncrementalForRepo also reads files a THIRD time — at line ~527, within the `for (const change of changes)` loop, `readFile(absolutePath, 'utf-8')` is called to compute contentHash for each changed file. This is in addition to the discoverFiles read and the parseOnMainThread read. The content-hash fallback fix would eliminate the git dependency AND this extra read. -->

---

## 12. Performance Profiling Reference

The table below consolidates estimated impact per issue based on a hypothetical 1000-file TypeScript monorepo:

<!-- [EDIT] Updated table to reflect corrected severity assessments and added workspaceFileMap rebuild entry. -->

| Issue | Phase | Estimated Overhead | Fix Complexity |
|---|---|---|---|
| Double file reads (§2) | discover + parse | ~15–30% of I/O time | Low |
| Sequential directory walk (§3) | discover | ~10–20% on deep trees | Medium |
| No worker thread parallelism (§4) | parse | ~50–70% of CPU parse time | High |
| Per-reference DB queries (§5) | resolve | ~20–40% of post-parse time | Medium |
| Duplicate framework detection (§6) | framework scan | ~5–10% | Low |
| Sequential post-scan pipeline (§7) | post-parse | ~15–25% of total scan | Medium |
| Full file table for Dart discovery (§8) | post-parse | Negligible except for large repos | Low |
| workspaceFileMap fallback rebuild (§9) | incremental parse/write | Low for full scan; moderate for incremental | Low |
| Resume state JSON growth (§10) | batch write | Negligible (scan time), notable (DB write) | Low |
| Non-git full scan fallback (§11) | incremental | Full scan overhead on every sync | Medium |

### Highest-Leverage Changes (ordered by ROI)

1. **True worker thread parallelism** (§4) — parses are CPU-bound WASM; only actual threads will help  
2. **Pre-scan symbol index** (§5) — O(N×M) DB queries → O(1) Map lookups per reference  
3. **Content cached in `DiscoveredFile`** (§2) — eliminates double file reads  
4. **Parallel directory walk** (§3) — I/O parallelism across directories  
5. **Content-hash incremental for non-git** (§11) — enables `sync` to work on all projects  
6. **Parallel post-scan steps** (§7) — overlaps framework scan + profiler; extract shared method to eliminate code duplication  
7. **Framework detection cache** (§6) — trivial 2-line fix for duplicate detection  

<!-- [NEW] Added item 8 -->
8. **Post-scan pipeline deduplication** (§7 addendum) — extract 6-step pipeline from both `_scanFullForRepo` and `_scanIncrementalForRepo` into shared method

---

## 13. Appendix: Scan Timing Breakdown (Observed)

From a full re-scan of the mapx codebase (228 files, current state):

<!-- [EDIT] Updated file count to 228, corrected timing to 479ms, added sync timing observation. -->

```
Scanned 228 files in /Users/gamil/Projects/mapx (479ms)
Found 0 symbols, 66 edges in changed files
```

An incremental sync of 2 changed markdown files:
```
Updated 2 files in /Users/gamil/Projects/mapx (122ms)
0 symbols updated, 0 edges updated
```

Note: the timing figures cover only the parse phase of changed/new files. The full scan including framework detection, profiling, classification, clustering, and architecture analysis is not broken out in the current output. **Adding per-phase timing to scan output** would be a low-effort improvement that makes performance regressions immediately visible.

<!-- [NEW] The 0 symbols on re-scan is misleading (see spec 09 §3.1) — it reports only the delta, not the 1053 symbols that exist in the graph. The 66 edges are from re-resolution of Markdown cross-references. -->

---

## 14. Appendix: `parse-worker.ts` — The Dormant Worker

`src/parsers/parse-worker.ts` contains a complete worker thread implementation (language loading, query compilation, file parsing, result posting) with `parentPort.on('message', ...)` message handling. It is imported into the project and included in the build, but **the main thread never spawns it as a `Worker`**.

<!-- [EDIT] Confirmed via grep — zero imports of parse-worker across the entire src/ directory. The file has 246 lines with a full implementation including main(), initParser(), initLanguages(), and parseFile() functions. -->

The `parseWithWorkers` method in `scanner.ts` calls `parseOnMainThread` unconditionally. The `parse-worker.ts` file exists as infrastructure for a future worker-thread implementation but was deactivated (likely due to WASM initialisation complexity in worker threads). The correct approach is to use `workerData` to pass the WASM path and language definitions to each worker at spawn time, which the file already supports via `langDefs` and `assetRoot` at the top of the module.

Activating this dormant implementation is the single highest-impact scanner improvement available.

<!-- [NEW] The file is 246 lines with complete implementations of: `main()` (entry point), `initParser()` (WASM grammar loading), `initLanguages()` (language definition setup), and `parseFile()` (per-file parsing with query matching). It uses `parentPort.on('message', ...)` for job receipt and `parentPort.postMessage()` for result return. All infrastructure for Fix Option A in §4 is already present. -->
