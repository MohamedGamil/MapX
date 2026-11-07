// Synthetic fixture for M5-17 (mapx arch init --preset ddd-contexts). Not a real application.
import { Money } from '../shared/Money';

export class Shipment {
  readonly cost = new Money(500);
}
