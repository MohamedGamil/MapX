// Synthetic fixture for M5-17-R1 (mapx arch init --preset onion). Not a real application.
import { Checkout } from '../application/Checkout';

export function priceHandler(id: number): number {
  return new Checkout().price(id);
}
