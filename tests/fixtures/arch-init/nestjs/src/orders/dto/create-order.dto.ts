// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { Order } from '../order.entity';

export class CreateOrderDto {
  total = 0;

  toEntity(): Order {
    return new Order(0, this.total);
  }
}
