// Synthetic fixture for M5-17 (mapx arch init --preset hexagonal). Not a real application.
import { PlaceOrder } from '../application/PlaceOrder';

export class HttpOrders {
  post(total: number) {
    return new PlaceOrder().run(total);
  }
}
