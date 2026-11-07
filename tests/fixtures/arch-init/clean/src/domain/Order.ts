// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
import { SystemClock } from '../infrastructure/SystemClock';

export class Order {
  // The violation: the domain reads the system clock.
  readonly placedAt = new SystemClock().now();

  constructor(readonly total: number) {}
}
