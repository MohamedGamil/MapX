import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative } from 'node:path';

export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'unchanged';
  /** The path before a rename; it no longer exists (M0-02-R3). */
  oldPath?: string;
}

const STATUS: Record<string, GitFileStatus['status']> = {
  'A': 'added', 'M': 'modified', 'D': 'removed', 'R': 'renamed', 'C': 'modified',
};

/** Parses `git diff --name-status` lines. A rename (`R<score> old new`) keeps its old path. */
function parseNameStatus(output: string): GitFileStatus[] {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const status = STATUS[parts[0].charAt(0)] || 'modified';
    const change: GitFileStatus = { path: parts[parts.length - 1], status };
    if (status === 'renamed' && parts.length > 2) change.oldPath = parts[1];
    return change;
  });
}

export interface GitBlobHash {
  path: string;
  hash: string;
}

/**
 * Blob ids at HEAD, keyed by path relative to `relativeTo` (default: the repo root). `ls-tree` prints
 * repo-relative paths; a repo that is not at the workspace root passes the workspace root, so the
 * keys are the stored file paths (M0-02-R4).
 */
export function getGitBlobHashes(repoRoot: string, relativeTo: string = repoRoot): Map<string, string> {
  const prefix = relative(relativeTo, repoRoot).replace(/\\/g, '/');
  const hashes = new Map<string, string>();
  try {
    // Single call: `git ls-tree -r HEAD` outputs lines like:
    //   100644 blob <hash>\t<path>
    const output = execFileSync('git', [...GIT_RAW_PATHS, 'ls-tree', '-r', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8', stdio: QUIET,
      maxBuffer: 50 * 1024 * 1024,
    });

    for (const line of output.split('\n')) {
      if (!line) continue;
      // Format: "<mode> <type> <hash>\t<path>"
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const parts = line.slice(0, tab).split(' ');
      if (parts.length < 3) continue;
      const hash = parts[2];
      const filePath = line.slice(tab + 1);
      if (hash && filePath) hashes.set(prefix ? `${prefix}/${filePath}` : filePath, hash);
    }
  } catch {
    // not a git repo or no commits
  }
  return hashes;
}

/**
 * The blob id git gives this content, as `git hash-object` without filters (autocrlf and the like).
 * A string is taken as UTF-8.
 */
export function gitBlobId(content: Buffer | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * The revision argument of `git diff`: `since` (a ref from the CLI, MCP or the index), else HEAD.
 * A value starting with `-` is refused, so a ref cannot become an option (`--output=…`), and the
 * array form of execFileSync keeps any shell syntax inert (review of M5-14: a `since` ran a shell command).
 */
function revision(since?: string): string[] {
  if (since && since.startsWith('-')) throw new Error(`Invalid revision: ${since}`);
  return [since || 'HEAD', '--'];
}

export function getChangedFiles(repoRoot: string, since?: string): GitFileStatus[] {
  const changes: GitFileStatus[] = [];

  // `--relative`: in a repo nested inside a larger checkout, git prints paths from the top level
  // and lists changes outside the repo; the scanner resolves paths against the repo root (M0-02-R3).
  try {
    const output = execFileSync('git', [...GIT_RAW_PATHS, 'diff', '--name-status', '--relative', ...revision(since)], {
      cwd: repoRoot,
      encoding: 'utf-8', stdio: QUIET,
      maxBuffer: 50 * 1024 * 1024,
    });
    changes.push(...parseNameStatus(output));
  } catch {
    // no previous commit or not a git repo
  }

  try {
    const stagedOutput = execFileSync('git', [...GIT_RAW_PATHS, 'diff', '--name-status', '--relative', '--cached'], {
      cwd: repoRoot,
      encoding: 'utf-8', stdio: QUIET,
    });
    for (const change of parseNameStatus(stagedOutput))
      if (!changes.find(c => c.path === change.path)) changes.push(change);
  } catch {
    // no staged changes
  }

  // New files git does not track yet are changes too (git diff never lists them).
  try {
    const untracked = execFileSync('git', [...GIT_RAW_PATHS, 'ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf-8', stdio: QUIET,
      maxBuffer: 50 * 1024 * 1024,
    });
    const listed = new Set(changes.map(c => c.path));
    for (const path of String(untracked ?? '').split('\n').filter(Boolean))
      if (!listed.has(path)) changes.push({ path, status: 'added' });
  } catch {
    // not a git repo
  }

  return changes;
}

/**
 * The commit `ref` names in `repoRoot` (any revision git parses: a branch, a tag, `HEAD~2`,
 * `:/text`, an abbreviated id), as a full object id, or null when it names no commit. A ref that
 * starts with `-` is refused. The ref is one argument after `--end-of-options`, and only the id git
 * printed (hex) is extended with `^{commit}`, so no string built from the ref reaches git (M5-98-R1).
 */
export function resolveCommit(repoRoot: string, ref: string): string | null {
  if (!ref.trim() || ref.startsWith('-')) throw new Error(`Invalid revision: ${ref}`);
  try {
    const id = execFileSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', ref], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim();
    if (!/^[0-9a-f]{40,64}$/.test(id)) return null;
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${id}^{commit}`], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim() || null;
  } catch {
    return null;
  }
}

/** Runs git and returns its output; a failure throws an Error carrying git's own message. */
function gitStrict(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', [...GIT_RAW_PATHS, ...args], { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim();
    throw new Error(`git ${args[0]} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }
}

/**
 * The files changed on this branch since `ref` (`mapx check --since`, M5-98-R1): the working tree
 * (committed, staged and unstaged edits) against the merge base of `ref` and HEAD, plus untracked
 * files. That is `git diff <ref>...HEAD` plus the working tree, not `git diff <ref>`: commits that
 * `ref` gained after this branch left it are not this branch's changes. With no merge base
 * (unrelated histories) the base is `ref` itself. Paths are relative to `repoRoot`; a rename keeps
 * its old path. `commit` is a commit id from `resolveCommit`. Unlike `getChangedFiles`, a git
 * failure throws: a partial list would read as "nothing changed".
 */
export function getChangedFilesSinceBranchPoint(repoRoot: string, commit: string): GitFileStatus[] {
  let base = commit;
  try {
    base = execFileSync('git', ['merge-base', commit, 'HEAD'], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim() || commit;
  } catch (err) {
    // Exit 1: the histories are unrelated. Anything else (no HEAD, a broken repository) is a failure.
    if ((err as { status?: number }).status !== 1) {
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim();
      throw new Error(`git merge-base failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
    }
  }
  const changes = parseNameStatus(gitStrict(repoRoot, ['diff', '--name-status', '--relative', base, '--']));
  const listed = new Set(changes.map((c) => c.path));
  for (const path of gitStrict(repoRoot, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    if (!listed.has(path)) changes.push({ path, status: 'added' });
  }
  return changes;
}

/**
 * Gitignored entries under the repo root, repo-relative; a wholly ignored folder is one entry ending
 * in `/` (`--directory`). The scan walk does not read .gitignore, so git sync needs them (M0-02-R7).
 * Null when git cannot list them: below an ignored folder it fails ("directory entry not superset of
 * prefix"), and the whole repo is ignored then.
 */
export function getIgnoredEntries(repoRoot: string): string[] | null {
  try {
    const output = execFileSync('git', [...GIT_RAW_PATHS, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], {
      cwd: repoRoot,
      encoding: 'utf-8', stdio: QUIET,
      maxBuffer: 50 * 1024 * 1024,
    });
    return String(output ?? '').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

export function getCurrentCommitSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim();
  } catch {
    return null;
  }
}

export function getPreviousCommitSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The folder's path from the top level of its git repository, with `/` and a trailing `/` (`sub/`):
 * `''` at the top level. Null when git cannot tell: outside git, or a git that refuses the folder
 * (a bad GIT_DIR, "dubious ownership"). CI reports locate files from the checkout root (M5-07-R1).
 */
export function getRepoPrefix(dir: string): string | null {
  try {
    return execFileSync('git', [...GIT_RAW_PATHS, 'rev-parse', '--show-prefix'], { cwd: dir, encoding: 'utf-8', stdio: QUIET }).replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

/** True when the folder or one of its ancestors has a `.git` (a directory, or a worktree's file). */
export function inGitCheckout(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

export function getRepoName(repoRoot: string): string {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf-8', stdio: QUIET }).trim();
    const basename = remote.split('/').pop() || 'unknown';
    return basename.replace(/\.git$/, '');
  } catch {
    return resolve(repoRoot).split('/').pop() || 'unknown';
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { SubmoduleInfo } from '../types.js';

// Non-ASCII paths as they are, not quoted and escaped (`"g\303\251n\303\251r\303\251s/"`).
/** Paths as bytes, not C-quoted. Every git call passes an argument array: no shell sees a ref or path. */
const GIT_RAW_PATHS = ['-c', 'core.quotePath=false'];

// Callers handle failures (e.g. a repo with no commits); keep git's stderr off the terminal.
const QUIET: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];

export function discoverSubmodules(repoRoot: string): SubmoduleInfo[] {
  const gitmodulesPath = join(repoRoot, '.gitmodules');
  if (!existsSync(gitmodulesPath)) return [];

  const submodules: SubmoduleInfo[] = [];
  try {
    const content = readFileSync(gitmodulesPath, 'utf-8');
    let currentSubmodule: Partial<SubmoduleInfo> | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

      const sectionMatch = trimmed.match(/^\[submodule\s+"([^"]+)"\]$/i);
      if (sectionMatch) {
        if (currentSubmodule && currentSubmodule.name && currentSubmodule.path && currentSubmodule.url) {
          submodules.push(currentSubmodule as SubmoduleInfo);
        }
        currentSubmodule = {
          name: sectionMatch[1],
          isInitialized: false
        };
        continue;
      }

      if (currentSubmodule && trimmed.includes('=')) {
        const eq = trimmed.indexOf('=');
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        const val = trimmed.slice(eq + 1).trim();

        if (key === 'path') {
          currentSubmodule.path = val;
          const subPath = join(repoRoot, val);
          const gitFile = join(subPath, '.git');
          currentSubmodule.isInitialized = existsSync(gitFile);
        } else if (key === 'url') {
          currentSubmodule.url = val;
        }
      }
    }

    if (currentSubmodule && currentSubmodule.name && currentSubmodule.path && currentSubmodule.url) {
      submodules.push(currentSubmodule as SubmoduleInfo);
    }
  } catch {
    // ignore
  }

  return submodules;
}
