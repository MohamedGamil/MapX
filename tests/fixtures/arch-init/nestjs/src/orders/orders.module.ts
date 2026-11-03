// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({ controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
