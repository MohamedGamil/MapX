import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Checks if any package.json in the repository contains any of the specified dependencies.
 */
export async function hasPackageJsonDependency(
  projectRoot: string,
  files: string[],
  dependencyNames: string[]
): Promise<boolean> {
  const packageJsonFiles = files.filter(f => f === 'package.json' || f.endsWith('/package.json'));
  if (packageJsonFiles.length === 0) {
    packageJsonFiles.push('package.json');
  }

  for (const file of packageJsonFiles) {
    const packageJsonPath = join(projectRoot, file);
    if (existsSync(packageJsonPath)) {
      try {
        const content = await readFile(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps) {
          for (const depName of dependencyNames) {
            if (deps[depName]) {
              return true;
            }
          }
        }
      } catch {
        // Ignored
      }
    }
  }
  return false;
}

/**
 * Checks if any composer.json in the repository contains any of the specified dependencies.
 */
export async function hasComposerDependency(
  projectRoot: string,
  files: string[],
  dependencyNames: string[]
): Promise<boolean> {
  const composerFiles = files.filter(f => f === 'composer.json' || f.endsWith('/composer.json'));
  if (composerFiles.length === 0) {
    composerFiles.push('composer.json');
  }

  for (const file of composerFiles) {
    const composerPath = join(projectRoot, file);
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(await readFile(composerPath, 'utf-8'));
        const deps = { ...composer.require, ...composer['require-dev'] };
        if (deps) {
          for (const depName of dependencyNames) {
            if (deps[depName]) {
              return true;
            }
          }
        }
      } catch {
        // Ignored
      }
    }
  }
  return false;
}

/** Parsed manifest dependencies by absolute manifest path (null: missing or unreadable). */
export type ManifestCache = Map<string, Record<string, unknown> | null>;

async function readManifestDependencies(path: string, cache: ManifestCache): Promise<Record<string, unknown> | null> {
  if (cache.has(path)) return cache.get(path)!;
  let deps: Record<string, unknown> | null = null;
  if (existsSync(path)) {
    try {
      const json = JSON.parse(await readFile(path, 'utf-8'));
      deps = path.endsWith('composer.json')
        ? { ...json.require, ...json['require-dev'] }
        : { ...json.dependencies, ...json.devDependencies };
    } catch {
      // Ignored: an unreadable manifest activates nothing
    }
  }
  cache.set(path, deps);
  return deps;
}

/**
 * Folders below the repo root whose `manifest` lists one of `dependencyNames`, workspace-relative
 * like `files` (`repoPrefix` is the repo's folder, '' for a repo at the workspace root). Manifests
 * are excluded from the scanned files by default, so candidates are the folders holding scanned
 * files and their ancestors below the repo root: excluded folders (node_modules/, vendor/) are
 * never read. A folder inside another returned folder is dropped, the outer one covers it (M3-07).
 */
export async function findNestedManifestScopes(
  workspaceRoot: string,
  repoPrefix: string,
  files: string[],
  manifest: 'package.json' | 'composer.json',
  dependencyNames: string[],
  cache: ManifestCache = new Map(),
): Promise<string[]> {
  const prefix = repoPrefix.replace(/\/+$/, '');
  const candidates = new Set<string>();
  for (const file of files) {
    let dir = parentDir(file);
    while (dir && dir !== prefix && (!prefix || dir.startsWith(`${prefix}/`)) && !candidates.has(dir)) {
      candidates.add(dir);
      dir = parentDir(dir);
    }
  }
  const matched: string[] = [];
  for (const dir of [...candidates].sort()) {
    const deps = await readManifestDependencies(join(workspaceRoot, dir, manifest), cache);
    if (deps && dependencyNames.some(name => deps[name])) matched.push(dir);
  }
  return matched.filter(dir => !matched.some(outer => dir.startsWith(`${outer}/`)));
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** True when `filePath` (workspace-relative) is inside one of the `scopes` folders ('' = all). */
export function isInScopes(filePath: string, scopes: string[]): boolean {
  return scopes.some(scope => scope === '' || filePath.startsWith(`${scope}/`));
}
