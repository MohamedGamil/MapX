// Synthetic fixture for the review of M5-24. The business layer uses persistence and the shared ids.
import { OrderRepository } from '../persistence/OrderRepository';
import { newId } from '../common/ids';

export class PlaceOrder {
  run() {
    return new OrderRepository().save(newId());
  }
}
