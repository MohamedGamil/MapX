import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { relative } from 'node:path';

/**
 * A pool of parse workers (M4-11, D025). Workers start lazily, up to the pool's size, and serve
 * every parse batch of a scan or sync run, and with a shared pool (mapx serve) successive runs:
 * each worker loads a grammar once for its lifetime instead of once per batch.
 *
 * Lifecycle:
 * - Per-run context (languages, ignored symbols, facade map, user languages) goes to each worker
 *   as a versioned message, sent only when it differs from what that worker last received.
 * - An idle worker is unref'd, so it never keeps the process alive, and the pool closes its
 *   workers after `idleMs` without work.
 * - A worker that crashes or exits is replaced and its file goes to another worker; a file that
 *   crashed two workers is handed back to the main thread. At most `size * 2` replacements per
 *   batch; after that the batch's remaining files are handed back.
 * - `close()` terminates every worker; the pool can start new ones afterwards.
 */

export interface PoolFile {
  absolutePath: string;
  language?: string;
}

export interface PoolContext {
  languages: Record<string, unknown>;
  ignoredSymbols?: unknown;
  userLanguages?: Record<string, unknown>;
  facadeMap?: Record<string, string>;
  assetRoot: string;
}

export interface PoolWorkerStats {
  files: number;
  grammars: Array<{ grammar: string; loads: number }>;
}

export interface PoolBatchResult<R> {
  /** One entry per file; undefined for a file handed back or not reached (abort). */
  results: Array<R | undefined>;
  /** Indexes of the files the main thread must parse, with the first reason. */
  handbacks: number[];
  handbackReason?: string;
}

interface PoolWorker {
  worker: Worker;
  ready: Promise<void>;
  contextVersion: number;
  busy: boolean;
  alive: boolean;
}

export interface WorkerPoolOptions {
  size: number;
  workerUrl: URL;
  /** Builds a worker; the scanner's source-mode bootstrap (tsx) lives there. */
  spawn: (workerUrl: URL, workerData: unknown) => Worker;
  idleMs?: number;
}

export class ParseWorkerPool {
  readonly size: number;
  private readonly workerUrl: URL;
  private readonly spawnWorker: WorkerPoolOptions['spawn'];
  private readonly idleMs: number;
  private workers: PoolWorker[] = [];
  private context: PoolContext | null = null;
  private contextKey = '';
  private contextVersion = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private closing = false;
  private queueTail: Promise<unknown> = Promise.resolve();
  /** Workers started over the pool's lifetime, and parse batches served. */
  started = 0;
  batches = 0;

  constructor(options: WorkerPoolOptions) {
    this.size = Math.max(1, options.size);
    this.workerUrl = options.workerUrl;
    this.spawnWorker = options.spawn;
    this.idleMs = options.idleMs ?? 60_000;
  }

  get liveWorkers(): number {
    return this.workers.filter(w => w.alive).length;
  }

  /** The context the batch about to run parses with; workers receive it before their next job. */
  private applyContext(context: PoolContext): void {
    const key = JSON.stringify(context);
    if (key === this.contextKey) return;
    this.context = context;
    this.contextKey = key;
    this.contextVersion++;
  }

  /**
   * Parses `files` with `context` on up to `size` workers. `onResult` sees every result as it
   * arrives; `isAborted` is checked before each dispatch. Rejects only when no worker can start.
   * Batches run one at a time, in call order: concurrent callers (two MCP tool calls) queue, and
   * each batch's context is applied only when it starts, so no batch parses with another's
   * settings (review 2026-11-01).
   */
  parse<R>(
    files: PoolFile[],
    workspaceRoot: string,
    context: PoolContext,
    onResult: (index: number, result: R) => void,
    isAborted: () => boolean,
  ): Promise<PoolBatchResult<R>> {
    const batch = this.queueTail.then(() => this.runBatch<R>(files, workspaceRoot, context, onResult, isAborted));
    this.queueTail = batch.catch(() => undefined);
    return batch;
  }

  private async runBatch<R>(
    files: PoolFile[],
    workspaceRoot: string,
    context: PoolContext,
    onResult: (index: number, result: R) => void,
    isAborted: () => boolean,
  ): Promise<PoolBatchResult<R>> {
    if (this.running) throw new Error('ParseWorkerPool: one batch at a time');
    this.running = true;
    this.closing = false;
    this.clearIdle();
    this.applyContext(context);
    this.workers = this.workers.filter(w => w.alive);
    this.batches++;
    const results: Array<R | undefined> = new Array(files.length);
    const handbacks: number[] = [];
    let handbackReason: string | undefined;
    const crashes = new Map<number, number>();
    let replacements = 0;
    let next = 0;
    const queue: number[] = [];
    const take = (): number | undefined => (queue.length > 0 ? queue.shift() : next < files.length ? next++ : undefined);
    const handBack = (index: number, reason: string) => {
      handbacks.push(index);
      handbackReason ??= reason;
    };

    try {
      const wanted = Math.min(this.size, files.length);
      while (this.liveWorkers < wanted) this.start();
      const lanes = this.workers.filter(w => w.alive).slice(0, wanted);
      // Any worker that starts proves the pool usable; if none does, the caller falls back.
      const readiness = await Promise.allSettled(lanes.map(w => w.ready));
      if (readiness.every(r => r.status === 'rejected')) {
        throw (readiness[0] as PromiseRejectedResult).reason;
      }

      const lane = async (initial: PoolWorker) => {
        let pw: PoolWorker | null = initial;
        try { await pw.ready; } catch { pw = null; }
        for (;;) {
          // A close() mid-batch ends the lanes: no replacement worker starts after it.
          if (isAborted() || this.closing) return;
          const index = take();
          if (index === undefined) return;
          if (!pw || !pw.alive) {
            if (replacements >= this.size * 2) { handBack(index, 'worker restarts exhausted'); continue; }
            replacements++;
            pw = this.start();
            try { await pw.ready; } catch { pw.alive = false; handBack(index, 'a worker could not start'); continue; }
          }
          const outcome = await this.run<R>(pw, index, files[index]!, workspaceRoot);
          if (outcome.kind === 'result') {
            results[index] = outcome.result;
            onResult(index, outcome.result);
          } else if (outcome.kind === 'handback') {
            handBack(index, outcome.reason);
          } else {
            // The worker died on this file: another worker tries it once, then the main thread.
            const n = (crashes.get(index) ?? 0) + 1;
            crashes.set(index, n);
            if (n >= 2) handBack(index, outcome.reason);
            else queue.push(index);
          }
        }
      };
      await Promise.all(lanes.map(lane));
      // Files left by lanes that ended (abort excepted) are the main thread's.
      if (!isAborted()) for (let i = take(); i !== undefined; i = take()) handBack(i, this.closing ? 'the pool closed' : 'no worker left');
      return { results, handbacks, handbackReason };
    } finally {
      this.running = false;
      for (const w of this.workers) if (w.alive) w.worker.unref();
      this.armIdle();
    }
  }

  /** Statistics of the live workers (files parsed and grammars loaded over their lifetime). */
  async workerStats(): Promise<PoolWorkerStats[]> {
    return Promise.all(this.workers.filter(w => w.alive).map(w => this.request(w)));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearIdle();
    const all = this.workers;
    this.workers = [];
    for (const w of all) w.alive = false;
    await Promise.all(all.map(w => w.worker.terminate().catch(() => 0)));
  }

  private start(): PoolWorker {
    const worker = this.spawnWorker(this.workerUrl, {});
    this.started++;
    const pw: PoolWorker = { worker, ready: Promise.resolve(), contextVersion: 0, busy: false, alive: true };
    pw.ready = new Promise<void>((resolveReady, rejectReady) => {
      const onMessage = (msg: any) => {
        if (msg?.type === 'ready') { cleanup(); resolveReady(); }
        else if (msg?.type === 'error') { cleanup(); pw.alive = false; void worker.terminate(); rejectReady(new Error(msg.error || 'Worker init error')); }
      };
      const onError = (err: Error) => { cleanup(); pw.alive = false; rejectReady(err); };
      const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); };
      worker.on('message', onMessage);
      worker.on('error', onError);
    });
    pw.ready.catch(() => { /* surfaced through parse() */ });
    worker.on('exit', () => { pw.alive = false; });
    worker.on('error', () => { pw.alive = false; });
    this.workers.push(pw);
    return pw;
  }

  private run<R>(pw: PoolWorker, index: number, file: PoolFile, workspaceRoot: string):
    Promise<{ kind: 'result'; result: R } | { kind: 'handback'; reason: string } | { kind: 'crash'; reason: string }> {
    const { worker } = pw;
    worker.ref();
    pw.busy = true;
    if (pw.contextVersion !== this.contextVersion) {
      worker.postMessage({ type: 'context', ...this.context });
      pw.contextVersion = this.contextVersion;
    }
    return new Promise((resolveRun) => {
      const done = (outcome: any) => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        pw.busy = false;
        resolveRun(outcome);
      };
      const onMessage = (msg: any) => {
        if (msg?.id !== index) return;
        if (msg.retryOnMainThread) done({ kind: 'handback', reason: String(msg.retryOnMainThread) });
        else done({ kind: 'result', result: msg });
      };
      const onError = (err: Error) => { pw.alive = false; void worker.terminate(); done({ kind: 'crash', reason: `${err?.name ?? 'Error'}: ${err?.message || err}` }); };
      const onExit = (code: number) => { pw.alive = false; done({ kind: 'crash', reason: `worker exited with code ${code}` }); };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ id: index, filePath: relative(workspaceRoot, file.absolutePath).replace(/\\/g, '/'), absolutePath: file.absolutePath, language: file.language });
    });
  }

  private request(pw: PoolWorker): Promise<PoolWorkerStats> {
    return new Promise((resolveStats) => {
      const timer = setTimeout(() => { pw.worker.off('message', onMessage); resolveStats({ files: -1, grammars: [] }); }, 2000);
      const onMessage = (msg: any) => {
        if (msg?.type !== 'stats') return;
        clearTimeout(timer);
        pw.worker.off('message', onMessage);
        resolveStats({ files: msg.files, grammars: msg.grammars });
      };
      pw.worker.on('message', onMessage);
      pw.worker.postMessage({ type: 'stats' });
    });
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.liveWorkers === 0) return;
    this.idleTimer = setTimeout(() => { void this.close(); }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * The parse worker's module, from this module's import.meta.url (src/core, beside the scanner).
 * - **Source** (tsx, Vitest): `src/parsers/parse-worker.ts`.
 * - **npm build** (tsup, unbundled): `dist/parsers/parse-worker.js`.
 * - **bun --compile binary:** every module is bundled into the binary's own, at `<root>/<binary>` in
 *   bun's embedded filesystem (`/$bunfs/root/` on Unix, `B:/~BUN/root/` on Windows); the worker,
 *   a second entrypoint of the build, sits beside it at `<root>/parsers/parse-worker.js` (M0-06-R2).
 */
export function parseWorkerUrl(moduleUrl: string): URL {
  if (/\/(\$bunfs|~BUN)\//.test(moduleUrl)) return new URL('./parsers/parse-worker.js', moduleUrl);
  return new URL(`../parsers/parse-worker${moduleUrl.endsWith('.ts') ? '.ts' : '.js'}`, moduleUrl);
}

/**
 * A parse worker pool for this build of MapX: source (tsx), npm build or compiled binary. Here, not
 * on Scanner, so the MCP server builds its shared pool without the scanner module (M4-11).
 */
export function createParsePool(options: { size?: number; idleMs?: number } = {}): ParseWorkerPool {
  return new ParseWorkerPool({
    size: options.size ?? Math.min(cpus().length || 4, 8),
    idleMs: options.idleMs,
    workerUrl: parseWorkerUrl(import.meta.url),
    spawn: (workerUrl, workerData) => /\.ts$/.test(workerUrl.pathname)
      ? new Worker(
          // Resolve tsx from MapX's own install, not from the scanned workspace (which usually
          // has no tsx), otherwise every source-mode scan silently fell back to one thread.
          `import { register } from '${import.meta.resolve('tsx/esm/api')}';
           register();
           import('${workerUrl.href}');`,
          { eval: true, workerData },
        )
      : new Worker(workerUrl, { workerData }),
  });
}
