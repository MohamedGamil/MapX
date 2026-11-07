// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { Module } from '@nestjs/common';
import { OrdersModule } from './orders/orders.module';

@Module({ imports: [OrdersModule] })
export class AppModule {}
