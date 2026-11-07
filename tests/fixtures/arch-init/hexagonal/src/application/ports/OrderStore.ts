// Synthetic fixture for M5-17 (mapx arch init --preset hexagonal). Not a real application.
import { Order } from '../../domain/Order';

export interface OrderStore {
  add(order: Order): void;
}
