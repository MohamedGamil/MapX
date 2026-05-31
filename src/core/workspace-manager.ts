import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { discoverSubmodules } from './git-tracker.js';
import type { SubmoduleInfo, MonorepoPackageInfo } from '../types.js';

/** Directories that are never git repository roots and should be skipped during deep scan. */
const NESTED_SCAN_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', 'coverage',
  'vendor', '.mapx', '__pycache__', '.next', '.nuxt', '.output',
  'target', 'bin', 'obj', '.svn', '.hg', '.tox', 'venv', '.venv',
  '.yarn', '.pnpm-store', '.turbo', 'out', '.parcel-cache',
]);

/**
 * Common monorepo workspace directories scanned as a fallback when no
 * explicit workspace manifest is present at the project root.
 */
const COMMON_MONO_DIRS = [
  'apps', 'packages', 'libs', 'services', 'modules', 'clients', 'backend', 'frontend',
];

/**
 * Files whose presence indicates that a directory is an independent
 * package / application root.
 */
const PACKAGE_MANIFESTS = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'composer.json', 'build.gradle', 'build.gradle.kts', 'pom.xml',
];

export class WorkspaceManager {
  static discoverSubmodules(repoRoot: string): SubmoduleInfo[] {
    return discoverSubmodules(repoRoot);
  }

  /**
   * Recursively scan `rootDir` up to `maxDepth` levels deep looking for
   * directories that contain a `.git` entry (file or folder).  The root
   * directory itself is excluded; each discovered repo is returned only once
   * and recursion stops at that boundary.
   *
   * Common noise directories (node_modules, dist, .cache, …) are skipped
   * automatically.
   */
  static discoverNestedGitRepos(rootDir: string, maxDepth = 3): SubmoduleInfo[] {
    const results: SubmoduleInfo[] = [];
    const absRoot = resolve(rootDir);

    function walk(dir: string, depth: number): void {
      if (depth > maxDepth) return;
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (NESTED_SCAN_SKIP.has(entry.name)) continue;
        const absEntry = join(dir, entry.name);
        const gitPath = join(absEntry, '.git');
        if (existsSync(gitPath)) {
          results.push({
            name: entry.name,
            path: relative(absRoot, absEntry),
            url: '',
            isInitialized: true,
          });
          // Don't recurse into a nested git repo; its own submodules are
          // discoverable via discoverSubmodules() when that repo is targeted.
          continue;
        }
        walk(absEntry, depth + 1);
      }
    }

    walk(absRoot, 1);
    return results;
  }

  /**
   * Discover monorepo packages/apps within `rootDir`.
   *
   * Detection strategy (in priority order):
   *  1. `pnpm-workspace.yaml` → `packages:` list
   *  2. `package.json` `workspaces` field (npm / yarn)
   *  3. `lerna.json` `packages` field (defaults to `packages/*`)
   *  4. `rush.json` `projects[].projectFolder`
   *  5. `Cargo.toml` `[workspace] members`
   *  6. `go.work` `use` block
   *  7. `turbo.json` / `nx.json` — uses common dirs as patterns
   *  8. Fallback: scan `apps/`, `packages/`, `libs/`, `services/`, … for
   *     directories that contain a package manifest.
   *
   * A directory is only included when it contains at least one recognised
   * package manifest (`package.json`, `Cargo.toml`, `go.mod`, …) and does
   * **not** have its own `.git` entry (those are handled by
   * `discoverNestedGitRepos`).
   */
  static discoverMonorepoPackages(rootDir: string): MonorepoPackageInfo[] {
    const absRoot = resolve(rootDir);
    const results: MonorepoPackageInfo[] = [];
    const seen = new Set<string>(); // absolute paths already processed

    const globs: string[] = [];
    let detectedManager = 'inferred';

    // ── 1. pnpm-workspace.yaml ─────────────────────────────────────
    const pnpmWsPath = join(absRoot, 'pnpm-workspace.yaml');
    if (existsSync(pnpmWsPath)) {
      try {
        const content = readFileSync(pnpmWsPath, 'utf-8');
        // Minimal YAML: capture lines under `packages:` block
        const block = content.match(/^packages:\s*\n((?:[ \t]*-[^\n]*\n?)*)/m);
        if (block) {
          const items = block[1]
            .split('\n')
            .map(l => l.replace(/^[ \t]*-\s*['"]?/, '').replace(/['"]?\s*$/, '').trim())
            .filter(Boolean);
          if (items.length > 0) {
            globs.push(...items);
            detectedManager = 'pnpm';
          }
        }
      } catch { /* ignore */ }
    }

    // ── 2. package.json workspaces (npm / yarn) ────────────────────
    const pkgJsonPath = join(absRoot, 'package.json');
    if (globs.length === 0 && existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        const ws = pkg.workspaces;
        if (Array.isArray(ws) && ws.length > 0) {
          globs.push(...ws);
          detectedManager = 'npm';
        } else if (ws && Array.isArray(ws.packages) && ws.packages.length > 0) {
          globs.push(...ws.packages);
          detectedManager = 'yarn';
        }
      } catch { /* ignore */ }
    }

    // ── 3. lerna.json ──────────────────────────────────────────────
    const lernaPath = join(absRoot, 'lerna.json');
    if (globs.length === 0 && existsSync(lernaPath)) {
      try {
        const lerna = JSON.parse(readFileSync(lernaPath, 'utf-8'));
        const lernaGlobs: string[] = Array.isArray(lerna.packages) ? lerna.packages : ['packages/*'];
        globs.push(...lernaGlobs);
        detectedManager = 'npm';
      } catch { /* ignore */ }
    }

    // ── 4. rush.json ───────────────────────────────────────────────
    const rushPath = join(absRoot, 'rush.json');
    if (globs.length === 0 && existsSync(rushPath)) {
      try {
        // Rush uses JSONC — strip // comments and /* */ blocks before parsing
        const raw = readFileSync(rushPath, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        const rush = JSON.parse(raw);
        if (Array.isArray(rush.projects)) {
          for (const proj of rush.projects) {
            if (typeof proj.projectFolder === 'string') {
              globs.push(proj.projectFolder);
            }
          }
          if (globs.length > 0) detectedManager = 'rush';
        }
      } catch { /* ignore */ }
    }

    // ── 5. Cargo.toml workspace ────────────────────────────────────
    const cargoPath = join(absRoot, 'Cargo.toml');
    if (globs.length === 0 && existsSync(cargoPath)) {
      try {
        const content = readFileSync(cargoPath, 'utf-8');
        // Minimal TOML: capture `members = [...]` inside `[workspace]`
        const wsBlock = content.match(/\[workspace\][^[]*?members\s*=\s*\[([\s\S]*?)\]/);
        if (wsBlock) {
          const rawMembers = wsBlock[1].match(/"([^"]+)"/g);
          if (rawMembers) {
            globs.push(...rawMembers.map(m => m.replace(/"/g, '')));
            detectedManager = 'cargo';
          }
        }
      } catch { /* ignore */ }
    }

    // ── 6. go.work ─────────────────────────────────────────────────
    const goWorkPath = join(absRoot, 'go.work');
    if (globs.length === 0 && existsSync(goWorkPath)) {
      try {
        const content = readFileSync(goWorkPath, 'utf-8');
        // use ( ./foo\n ./bar ) or use ./foo ./bar (inline)
        const blockMatch = content.match(/^use\s*\(\n([\s\S]*?)\n\)/m);
        const inlineMatch = content.match(/^use\s+(.+)/m);
        const useLines = blockMatch
          ? blockMatch[1].split('\n').map(l => l.trim()).filter(Boolean)
          : inlineMatch
            ? inlineMatch[1].split(/\s+/).filter(Boolean)
            : [];
        for (const line of useLines) {
          const p = line.replace(/^\.\//, '').replace(/^\//, '').trim();
          if (p && p !== '.') globs.push(p);
        }
        if (globs.length > 0) detectedManager = 'go';
      } catch { /* ignore */ }
    }

    // ── 7. turbo.json / nx.json (signal only — no explicit globs) ──
    const hasTurbo = existsSync(join(absRoot, 'turbo.json'));
    const hasNx = existsSync(join(absRoot, 'nx.json'));
    if ((hasTurbo || hasNx) && globs.length === 0) {
      globs.push('apps/*', 'packages/*', 'libs/*');
      detectedManager = hasTurbo ? 'turborepo' : 'nx';
    }

    // ── Expand glob patterns → concrete relative directory paths ───
    type DirEntry = { name: string; isDirectory(): boolean };
    const expandGlob = (pattern: string): string[] => {
      const norm = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
      if (norm.endsWith('/*') || norm.endsWith('/**')) {
        const dir = norm.replace(/\/\*\*?$/, '');
        const absDir = join(absRoot, dir);
        if (!existsSync(absDir)) return [];
        try {
          return (readdirSync(absDir, { withFileTypes: true }) as DirEntry[])
            .filter(e => e.isDirectory() && !NESTED_SCAN_SKIP.has(e.name))
            .map(e => `${dir}/${e.name}`);
        } catch { return []; }
      }
      // Exact path (no wildcard) — used by rush / go / cargo
      if (!norm.includes('*')) return [norm];
      return []; // complex globs (e.g. apps/**/*) — skip; too ambiguous
    };

    const expandedDirs = new Set<string>();
    for (const pattern of globs) {
      for (const d of expandGlob(pattern)) expandedDirs.add(d);
    }

    // ── Resolve package info for each directory ────────────────────
    const resolvePkgName = (absDir: string): string => {
      const dirName = basename(absDir);
      const pkgPath = join(absDir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (typeof pkg.name === 'string' && pkg.name) {
            return pkg.name.replace(/^@[^/]+\//, ''); // strip @scope/ prefix
          }
        } catch { /* ignore */ }
      }
      const cargoManifest = join(absDir, 'Cargo.toml');
      if (existsSync(cargoManifest)) {
        try {
          const m = readFileSync(cargoManifest, 'utf-8').match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/s);
          if (m) return m[1];
        } catch { /* ignore */ }
      }
      return dirName;
    };

    const tryAdd = (relPath: string): void => {
      const norm = relPath.replace(/\\/g, '/');
      const absDir = join(absRoot, norm);
      if (!existsSync(absDir)) return;
      if (seen.has(absDir)) return;
      seen.add(absDir);
      // Skip directories with their own .git (handled by discoverNestedGitRepos)
      if (existsSync(join(absDir, '.git'))) return;
      // Must look like a package
      if (!PACKAGE_MANIFESTS.some(m => existsSync(join(absDir, m)))) return;
      results.push({ name: resolvePkgName(absDir), path: norm, packageManager: detectedManager });
    };

    for (const relDir of expandedDirs) tryAdd(relDir);

    // ── Fallback: scan common dirs when no manifest found ──────────
    if (results.length === 0) {
      for (const dir of COMMON_MONO_DIRS) {
        const absDir = join(absRoot, dir);
        if (!existsSync(absDir)) continue;
        try {
          const entries = readdirSync(absDir, { withFileTypes: true }) as DirEntry[];
          for (const entry of entries) {
            if (!entry.isDirectory() || NESTED_SCAN_SKIP.has(entry.name)) continue;
            tryAdd(`${dir}/${entry.name}`);
          }
        } catch { /* ignore */ }
      }
    }

    return results;
  }

  static discoverPeerRepos(workspaceRoot: string): SubmoduleInfo[] {
    const parentDir = dirname(resolve(workspaceRoot));
    if (!existsSync(parentDir)) return [];

    const peers: SubmoduleInfo[] = [];
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === basename(workspaceRoot)) continue;

        const siblingPath = join(parentDir, entry.name);
        const gitPath = join(siblingPath, '.git');
        if (existsSync(gitPath)) {
          peers.push({
            name: entry.name,
            path: `../${entry.name}`,
            url: '',
            isInitialized: true,
          });
        }
      }
    } catch {
      // ignore
    }
    return peers;
  }

  static discoverVSCodeWorkspace(workspaceFile: string, workspaceRoot: string): SubmoduleInfo[] {
    if (!existsSync(workspaceFile)) return [];

    const repos: SubmoduleInfo[] = [];
    try {
      const content = readFileSync(workspaceFile, 'utf-8');
      // Simple parse allowing comments or basic trailing commas if possible, but JSON.parse is standard.
      const ws = JSON.parse(content);
      const wsDir = dirname(resolve(workspaceFile));

      if (ws && Array.isArray(ws.folders)) {
        for (const folder of ws.folders) {
          if (typeof folder.path === 'string') {
            const absFolder = resolve(wsDir, folder.path);
            if (absFolder === resolve(workspaceRoot)) continue;

            const gitPath = join(absFolder, '.git');
            if (existsSync(gitPath)) {
              const relPath = relative(resolve(workspaceRoot), absFolder);
              repos.push({
                name: folder.name || basename(absFolder),
                path: relPath,
                url: '',
                isInitialized: true,
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return repos;
  }
}
