// A private temp folder for the run (M4-09-R5); global-teardown.ts checks it is empty at the end.
import { isolateTmp } from '../helpers/run-tmp.js';

export default function globalSetup() {
  isolateTmp();
}
