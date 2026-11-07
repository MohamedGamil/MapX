// Util: a layer Controller may use but never does (a dead allowance).
export class Clock {
  now(): number {
    return Date.now();
  }
}
