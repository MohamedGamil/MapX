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
