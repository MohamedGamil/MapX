import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plan } from './model.ts';

/** Problem with an evidence/approval path, or null when it is a regular file inside the repo. */
export function artifactProblem(root: string, path: string | null | undefined): string | null {
  if (!path?.trim()) return 'empty path';
  if (isAbsolute(path)) return 'absolute path';
  const target = resolve(root, path);
  if (!existsSync(target)) return 'missing';
  // Resolve symlinks on both sides so links cannot point evidence outside the repository.
  const inside = relative(realpathSync(root), realpathSync(target));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return 'outside repository';
  if (!statSync(target).isFile()) return 'not a regular file';
  return null;
}

export function checkArtifacts(plan: Plan, root: string): void {
  for (const task of plan.tasks.filter((t) => t.status === 'DONE'))
    for (const evidence of task.evidence) {
      const problem = artifactProblem(root, evidence.artifact);
      if (problem)
        throw new Error(`Invalid evidence file for ${task.id} (${problem}): ${evidence.artifact}`);
    }
  for (const gate of plan.gates.filter((g) => g.status === 'APPROVED')) {
    const problem = artifactProblem(root, gate.artifact);
    if (problem)
      throw new Error(`Invalid approval file for ${gate.id} (${problem}): ${gate.artifact}`);
  }
}
