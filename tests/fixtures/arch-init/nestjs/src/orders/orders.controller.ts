// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AuthGuard } from './auth.guard';
import { Order } from './order.entity';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto);
  }

  // The violation: the controller hands out the entity itself.
  @Get()
  first(): Order {
    return new Order(1, 0);
  }
}
