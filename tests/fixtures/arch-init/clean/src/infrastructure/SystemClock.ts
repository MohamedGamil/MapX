// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
export class SystemClock {
  now(): number {
    return Date.now();
  }
}
