// Builds the dashboard bundle once before the browser tests (M4-19), and says so when no Chromium
// is installed: the specs then skip.
import { execFileSync } from 'node:child_process';
import { REPO } from '../../scripts/ui/workspace.js';
import { browserMissing } from './harness.js';

export default function globalSetup() {
  const missing = browserMissing();
  if (missing) {
    console.warn(`[test:ui] ${missing}`);
    return;
  }
  execFileSync('npm', ['run', '-s', 'build:ui'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
}
