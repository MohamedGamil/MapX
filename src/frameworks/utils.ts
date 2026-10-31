import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * True when the repo root's package.json lists one of `dependencyNames`. Only the root manifest
 * is read, even when the user's filters put nested package.json files in `files`: a manifest below
 * the root activates a detector for its own folder only (`findNestedManifestScopes`), never for
 * the whole repo (M3-07-R1).
 */
export async function hasPackageJsonDependency(
  projectRoot: string,
  _files: string[],
  dependencyNames: string[]
): Promise<boolean> {
  const deps = await readManifestDependencies(join(projectRoot, 'package.json'), new Map());
  return !!deps && dependencyNames.some(name => deps[name]);
}

/** Like `hasPackageJsonDependency`, for the repo root's composer.json (M3-07-R1). */
export async function hasComposerDependency(
  projectRoot: string,
  _files: string[],
  dependencyNames: string[]
): Promise<boolean> {
  const deps = await readManifestDependencies(join(projectRoot, 'composer.json'), new Map());
  return !!deps && dependencyNames.some(name => deps[name]);
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
