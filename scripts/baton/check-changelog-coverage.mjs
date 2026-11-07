#!/usr/bin/env node
// Every entry under CHANGELOG.md [Unreleased] must cite a BATON task id that exists in
// docs/baton/TASKS.json, so shipped work cannot bypass the plan again (docs/baton M0-30).
// Usage: node scripts/baton/check-changelog-coverage.mjs [CHANGELOG.md] [TASKS.json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const changelog = readFileSync(resolve(process.argv[2] ?? 'CHANGELOG.md'), 'utf8');
const plan = JSON.parse(readFileSync(resolve(process.argv[3] ?? 'docs/baton/TASKS.json'), 'utf8'));
const ids = new Set(plan.tasks.map((t) => t.id));

const start = changelog.indexOf('## [Unreleased]');
if (start < 0) {
  console.error('No [Unreleased] section in the changelog');
  process.exit(2);
}
const next = changelog.indexOf('\n## [', start + 1);
const section = changelog.slice(start, next < 0 ? undefined : next);
// Top-level bullets only; indented lines continue the entry above them.
const entries = section.split('\n').filter((line) => /^- /.test(line));

const problems = [];
for (const entry of entries) {
  const cited = entry.match(/\bM\d+-\d{2,}(?:-R\d+)?\b/g) ?? [];
  const label = entry.slice(2, 72);
  if (!cited.length) problems.push(`no task id: ${label}`);
  for (const id of cited) if (!ids.has(id)) problems.push(`unknown task ${id}: ${label}`);
}
console.log(`${entries.length} unreleased changelog entries checked against ${ids.size} tasks.`);
for (const p of problems) console.error(`FAIL ${p}`);
process.exitCode = problems.length ? 1 : 0;
