// vitest's global setup and teardown (M4-09-R5): the run gets a private temp folder (so no other
// process's mapx-* folders matter), and the teardown fails, naming each entry, when a test left
// one in it. The folder is removed either way. See tests/helpers/run-tmp.ts.
import { finishTmp, isolateTmp } from './helpers/run-tmp.js';

export default function setup(): () => void {
  const dir = isolateTmp({ exitOnSignal: true });
  return () => finishTmp(dir, 'vitest');
}
