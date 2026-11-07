// Builds the dashboard bundle once before the browser tests (M4-19), and says so when no Chromium
// is installed: the specs then skip. First it gives the run a private temp folder (M4-09-R5), which
// global-teardown.ts checks is empty at the end.
import { execFileSync } from 'node:child_process';
import { REPO } from '../../scripts/ui/workspace.js';
import { isolateTmp } from '../helpers/run-tmp.js';
import { browserMissing } from './harness.js';

export default function globalSetup() {
  isolateTmp();
  const missing = browserMissing();
  if (missing) {
    console.warn(`[test:ui] ${missing}`);
    return;
  }
  execFileSync('npm', ['run', '-s', 'build:ui'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
}
