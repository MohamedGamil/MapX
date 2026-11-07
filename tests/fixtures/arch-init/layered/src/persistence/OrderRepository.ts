// Synthetic fixture for M5-17 (mapx arch init --preset layered). Not a real application.
import { Money } from '../common/Money';

export class OrderRepository {
  total(): Money {
    return new Money(0);
  }
}
