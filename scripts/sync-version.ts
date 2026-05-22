#!/usr/bin/env tsx
/**
 * Sync the version from the root VERSION file into package.json and
 * scripts/templates/VERSION.
 * Usage: tsx scripts/sync-version.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const versionFile = resolve(root, 'VERSION');
const pkgFile = resolve(root, 'package.json');
const templateVersionFile = resolve(root, 'scripts', 'templates', 'VERSION');

const version = readFileSync(versionFile, 'utf-8').trim();

const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
if (pkg.version === version) {
  console.log(`package.json already at version ${version}`);
} else {
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Updated package.json version to ${version}`);
}

const templateVersion = readFileSync(templateVersionFile, 'utf-8').trim();
if (templateVersion === version) {
  console.log(`scripts/templates/VERSION already at version ${version}`);
} else {
  writeFileSync(templateVersionFile, version + '\n');
  console.log(`Updated scripts/templates/VERSION to ${version}`);
}
