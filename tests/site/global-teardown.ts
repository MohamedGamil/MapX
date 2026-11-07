import { finishTmp, RUN_TMP_ENV } from '../helpers/run-tmp.js';

export default function globalTeardown() {
  finishTmp(process.env[RUN_TMP_ENV], 'test:site');
}
