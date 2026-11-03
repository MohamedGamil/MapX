// Synthetic fixture for M5-17-R1 (mapx arch init --preset mvvm). Not a real application.
import { Order } from '../models/Order';

export class OrderService {
  load(): Order {
    return new Order(1);
  }
}
