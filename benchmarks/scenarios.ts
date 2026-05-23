/**
 * Benchmark scenarios — defines the "without mapx" and "with mapx" approaches
 * for common agentic coding tasks.
 *
 * Each scenario simulates what an LLM agent would need to read/send
 * to accomplish a specific task, measuring total token cost for each approach.
 */

export interface ScenarioResult {
  name: string;
  description: string;
  baseline: ApproachResult;
  mapx: ApproachResult;
  savings: {
    tokens: number;
    percent: number;
    toolCalls: number;
  };
}

export interface ApproachResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  breakdown: { label: string; tokens: number }[];
}

export interface ScenarioDef {
  name: string;
  description: string;
  /** Simulate the baseline (no mapx) approach — returns token counts */
  baseline: (ctx: ScenarioContext) => ApproachResult;
  /** Simulate the mapx approach — returns token counts */
  mapx: (ctx: ScenarioContext) => ApproachResult;
}

export interface ScenarioContext {
  /** All project files with paths and sizes */
  files: FileInfo[];
  /** Total lines of code */
  totalLines: number;
  /** Total file size in bytes */
  totalBytes: number;
  /** Number of symbols in the graph */
  symbolCount: number;
  /** Number of edges in the graph */
  edgeCount: number;
  /** mapx export --format=llm output token count */
  llmExportTokens: number;
  /** mapx export --format=json output token count */
  jsonExportTokens: number;
  /** Token estimator function */
  estimateTokens: (text: string) => number;
  /** Average file token count */
  avgFileTokens: number;
  /** Languages in the project */
  languages: string[];
}

export interface FileInfo {
  path: string;
  sizeBytes: number;
  lines: number;
  language: string;
  tokens: number;
}

// ─── Scenario definitions ──────────────────────────────────────

export const SCENARIOS: ScenarioDef[] = [

  // ── S1: Understand project structure ────────────────────────
  {
    name: 'understand-structure',
    description: 'Get an overview of the project: what files exist, how they relate, key entry points',
    baseline: (ctx) => {
      // Without mapx: agent reads directory listing + opens 10–15 key files to understand structure
      const dirListingTokens = ctx.files.length * 8; // ~8 tokens per path line
      const filesToRead = Math.min(15, Math.ceil(ctx.files.length * 0.15)); // read ~15% of files
      const readTokens = filesToRead * ctx.avgFileTokens;
      const systemPrompt = 200;
      const agentReasoning = 500;
      const inputTokens = systemPrompt + dirListingTokens + readTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1 + filesToRead, // 1 dir listing + N file reads
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: `Directory listing (${ctx.files.length} files)`, tokens: dirListingTokens },
          { label: `Read ${filesToRead} files`, tokens: readTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: agent calls mapx_export (LLM format) — gets structured overview in one call
      const systemPrompt = 200;
      const agentReasoning = 400;
      const inputTokens = systemPrompt + ctx.llmExportTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1, // single mapx_export call
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'mapx_export (LLM summary)', tokens: ctx.llmExportTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
  },

  // ── S2: Find a symbol definition ───────────────────────────
  {
    name: 'find-symbol',
    description: 'Find where a class/function is defined and understand its interface',
    baseline: (ctx) => {
      // Without mapx: agent greps for the symbol name across files, then reads matching files
      const grepOutputTokens = 15 * 20; // ~15 matches, ~20 tokens each
      const filesToRead = 3; // reads 3 matching files to find the definition
      const readTokens = filesToRead * ctx.avgFileTokens;
      const systemPrompt = 200;
      const agentReasoning = 300;
      const inputTokens = systemPrompt + grepOutputTokens + readTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1 + filesToRead, // 1 grep + N file reads
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'Grep results (~15 matches)', tokens: grepOutputTokens },
          { label: `Read ${filesToRead} files`, tokens: readTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: mapx_query returns exact location + signature in ~50 tokens
      const queryResultTokens = 80; // precise result with file path, line, signature
      const systemPrompt = 200;
      const agentReasoning = 200;
      const fileReadTokens = ctx.avgFileTokens * 0.3; // only read relevant portion
      const inputTokens = systemPrompt + queryResultTokens + fileReadTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 2, // mapx_query + targeted file read
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'mapx_query result', tokens: queryResultTokens },
          { label: 'Read relevant section', tokens: Math.round(fileReadTokens) },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
  },

  // ── S3: Trace dependencies ─────────────────────────────────
  {
    name: 'trace-dependencies',
    description: 'Understand what a file depends on and what depends on it',
    baseline: (ctx) => {
      // Without mapx: read the file, grep for imports, open each imported file, grep for reverse refs
      const targetFileTokens = ctx.avgFileTokens;
      const importedFiles = 6;
      const importedTokens = importedFiles * ctx.avgFileTokens;
      const reverseGrepTokens = 20 * 20; // ~20 reverse matches
      const systemPrompt = 200;
      const agentReasoning = 400;
      const inputTokens = systemPrompt + targetFileTokens + importedTokens + reverseGrepTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 2 + importedFiles, // read file + grep reverse + read N imports
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'Read target file', tokens: targetFileTokens },
          { label: `Read ${importedFiles} imported files`, tokens: importedTokens },
          { label: 'Grep for reverse references', tokens: reverseGrepTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: mapx_dependencies returns structured dep list in ~200 tokens
      const depsResultTokens = 250;
      const systemPrompt = 200;
      const agentReasoning = 250;
      const inputTokens = systemPrompt + depsResultTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1,
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'mapx_dependencies result', tokens: depsResultTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
  },

  // ── S4: Pre-refactor impact assessment ─────────────────────
  {
    name: 'impact-analysis',
    description: 'Assess the blast radius before modifying a class/function',
    baseline: (ctx) => {
      // Without mapx: read the symbol, grep all references, read each referencing file,
      // grep transitive references — very expensive
      const targetFileTokens = ctx.avgFileTokens;
      const directRefs = 8;
      const directRefTokens = directRefs * ctx.avgFileTokens;
      const transitiveGrepTokens = 30 * 20;
      const transitiveReads = 4;
      const transitiveReadTokens = transitiveReads * ctx.avgFileTokens;
      const systemPrompt = 200;
      const agentReasoning = 600;
      const inputTokens = systemPrompt + targetFileTokens + directRefTokens +
        transitiveGrepTokens + transitiveReadTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 2 + directRefs + transitiveReads, // reads + greps
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'Read target file', tokens: targetFileTokens },
          { label: `Read ${directRefs} direct references`, tokens: directRefTokens },
          { label: 'Grep transitive references', tokens: transitiveGrepTokens },
          { label: `Read ${transitiveReads} transitive files`, tokens: transitiveReadTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: mapx_impact returns blast radius + risk in ~400 tokens
      const impactResultTokens = 400;
      const callersResultTokens = 200;
      const systemPrompt = 200;
      const agentReasoning = 350;
      const inputTokens = systemPrompt + impactResultTokens + callersResultTokens;
      const outputTokens = agentReasoning;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 2, // mapx_impact + mapx_callers
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'mapx_impact result', tokens: impactResultTokens },
          { label: 'mapx_callers result', tokens: callersResultTokens },
          { label: 'Agent reasoning', tokens: agentReasoning },
        ],
      };
    },
  },

  // ── S5: Multi-file code modification ───────────────────────
  {
    name: 'multi-file-edit',
    description: 'Implement a feature that touches 5+ files: understand context, make changes, verify',
    baseline: (ctx) => {
      // Without mapx: read directory, understand structure (10 files), find relevant files (grep),
      // read all related files, make edits, verify
      const dirListingTokens = ctx.files.length * 8;
      const structureFiles = 10;
      const structureTokens = structureFiles * ctx.avgFileTokens;
      const grepTokens = 25 * 20;
      const editFiles = 6;
      const editFileTokens = editFiles * ctx.avgFileTokens;
      const verifyTokens = editFiles * ctx.avgFileTokens * 0.5; // re-read edited files
      const systemPrompt = 200;
      const agentReasoning = 1200;
      const inputTokens = systemPrompt + dirListingTokens + structureTokens +
        grepTokens + editFileTokens + verifyTokens;
      const outputTokens = agentReasoning + editFiles * 200; // code generation output

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1 + structureFiles + 2 + editFiles * 2, // dir + reads + greps + edits + verify
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'Directory listing', tokens: dirListingTokens },
          { label: `Read ${structureFiles} files for context`, tokens: structureTokens },
          { label: 'Grep for related code', tokens: grepTokens },
          { label: `Read ${editFiles} files to edit`, tokens: editFileTokens },
          { label: 'Re-read for verification', tokens: Math.round(verifyTokens) },
          { label: 'Agent reasoning + code gen', tokens: agentReasoning + editFiles * 200 },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: export overview, search for relevant symbols, get deps, targeted reads
      const exportTokens = ctx.llmExportTokens;
      const searchTokens = 150;
      const depsTokens = 200;
      const editFiles = 6;
      const editFileTokens = editFiles * ctx.avgFileTokens * 0.4; // only read relevant portions
      const systemPrompt = 200;
      const agentReasoning = 800;
      const inputTokens = systemPrompt + exportTokens + searchTokens +
        depsTokens + editFileTokens;
      const outputTokens = agentReasoning + editFiles * 200;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 3 + editFiles, // export + search + deps + targeted reads
        breakdown: [
          { label: 'System prompt', tokens: systemPrompt },
          { label: 'mapx_export overview', tokens: exportTokens },
          { label: 'mapx_search + mapx_deps', tokens: searchTokens + depsTokens },
          { label: `Targeted reads (${editFiles} files)`, tokens: Math.round(editFileTokens) },
          { label: 'Agent reasoning + code gen', tokens: agentReasoning + editFiles * 200 },
        ],
      };
    },
  },

  // ── S6: Full session (15 tasks) ────────────────────────────
  {
    name: 'full-session',
    description: 'Simulate a full coding session: 15 tasks including exploration, searches, edits, and reviews',
    baseline: (ctx) => {
      // Without mapx: typical session reads ~40% of codebase files, many greps, many re-reads
      const uniqueFilesRead = Math.min(ctx.files.length, Math.ceil(ctx.files.length * 0.4));
      const reReadMultiplier = 2.5; // files get read ~2.5 times on average
      const totalFileReads = Math.round(uniqueFilesRead * reReadMultiplier);
      const readTokens = totalFileReads * ctx.avgFileTokens;
      const grepCalls = 20;
      const grepTokens = grepCalls * 15 * 20;
      const dirListings = 5;
      const dirTokens = dirListings * ctx.files.length * 8;
      const systemPrompt = 200 * 15; // 15 turns
      const agentReasoning = 400 * 15;
      const codeGen = 300 * 8; // 8 edits
      const inputTokens = systemPrompt + readTokens + grepTokens + dirTokens;
      const outputTokens = agentReasoning + codeGen;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: dirListings + totalFileReads + grepCalls + 8,
        breakdown: [
          { label: `System prompts (15 turns)`, tokens: systemPrompt },
          { label: `Read ${totalFileReads} file reads (${uniqueFilesRead} unique)`, tokens: readTokens },
          { label: `${grepCalls} grep calls`, tokens: grepTokens },
          { label: `${dirListings} directory listings`, tokens: dirTokens },
          { label: 'Agent reasoning + code gen', tokens: agentReasoning + codeGen },
        ],
      };
    },
    mapx: (ctx) => {
      // With mapx: 1 export at start, targeted queries, much fewer file reads
      const exportTokens = ctx.llmExportTokens;
      const syncCalls = 3; // 3 mapx_sync calls during session
      const syncTokens = 50 * syncCalls;
      const searchCalls = 10;
      const searchTokens = 100 * searchCalls;
      const depsCalls = 5;
      const depsTokens = 200 * depsCalls;
      const impactCalls = 2;
      const impactTokens = 400 * impactCalls;
      const uniqueFilesRead = Math.min(ctx.files.length, Math.ceil(ctx.files.length * 0.15));
      const readTokens = uniqueFilesRead * ctx.avgFileTokens * 0.6; // read less of each file
      const systemPrompt = 200 * 15;
      const agentReasoning = 350 * 15;
      const codeGen = 300 * 8;
      const inputTokens = systemPrompt + exportTokens + syncTokens + searchTokens +
        depsTokens + impactTokens + readTokens;
      const outputTokens = agentReasoning + codeGen;

      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        toolCalls: 1 + syncCalls + searchCalls + depsCalls + impactCalls + uniqueFilesRead + 8,
        breakdown: [
          { label: `System prompts (15 turns)`, tokens: systemPrompt },
          { label: 'mapx_export (1 call)', tokens: exportTokens },
          { label: `mapx_sync (${syncCalls} calls)`, tokens: syncTokens },
          { label: `mapx_search/query (${searchCalls} calls)`, tokens: searchTokens },
          { label: `mapx_deps (${depsCalls} calls)`, tokens: depsTokens },
          { label: `mapx_impact (${impactCalls} calls)`, tokens: impactTokens },
          { label: `Targeted file reads (${uniqueFilesRead} files)`, tokens: Math.round(readTokens) },
          { label: 'Agent reasoning + code gen', tokens: agentReasoning + codeGen },
        ],
      };
    },
  },
];
