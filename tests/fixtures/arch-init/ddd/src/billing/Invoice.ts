// Synthetic fixture for M5-17 (mapx arch init --preset ddd-contexts). Not a real application.
import { Money } from '../shared/Money';
import { Shipment } from '../shipping/Shipment';

export class Invoice {
  readonly total = new Money(1000);
  // The violation: billing reaches into the shipping context.
  readonly shipment = new Shipment();
}
