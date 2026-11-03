// Synthetic fixture for M5-17 (mapx arch init --preset clean). Not a real application.
import { Order } from '../domain/Order';

export interface OrderRepository {
  save(order: Order): void;
}
