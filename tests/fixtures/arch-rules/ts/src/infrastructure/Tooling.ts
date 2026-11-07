// Synthetic (M5-20): npm attribution, labelled in expected-externals.json. A transitive production
// package (debug, through express) and a transitive dev one (semver, through eslint); a deep import of
// a dev dependency; built-ins with and without `node:`; a package no manifest or lockfile names; and
// the npm package `sqlite` (only `node:sqlite` is built in).
import debug from 'debug';
import { satisfies } from 'semver';
import get from 'lodash/get';
import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';
import { test } from 'node:test';
import pad from 'left-pad';
import { open } from 'sqlite';

export function toolingCheck(range: string): boolean {
  debug('tooling');
  new EventEmitter();
  return satisfies('1.0.0', range);
}
