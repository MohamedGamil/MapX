// Synthetic fixture for M5-17-R1 (mapx arch init --preset mvvm). Not a real application.
import { OrderService } from '../services/OrderService';
import type { Order } from '../models/Order';

export class OrderViewModel {
  order: Order | null = null;

  constructor(private readonly service = new OrderService()) {}

  refresh(): void {
    this.order = this.service.load();
  }
}
