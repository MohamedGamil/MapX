// Fails the run when a browser test left an entry in the run's private temp folder, naming it
// (M4-09-R5): a served workspace, Playwright's playwright-artifacts-*, a browser profile. The folder
// is made in global-setup.ts and removed here either way.
import { finishTmp, RUN_TMP_ENV } from '../helpers/run-tmp.js';

export default function globalTeardown() {
  finishTmp(process.env[RUN_TMP_ENV], 'test:ui');
}
