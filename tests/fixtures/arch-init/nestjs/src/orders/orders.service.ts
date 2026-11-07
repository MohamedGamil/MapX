// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { Injectable } from '@nestjs/common';
import { Order } from './order.entity';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  create(dto: CreateOrderDto): Order {
    return new Order(1, dto.total);
  }
}
