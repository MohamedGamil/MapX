// Synthetic fixture for M5-17 (mapx arch init --preset nestjs). Not a real application.
import { CanActivate, Injectable } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly orders: OrdersService) {}

  canActivate(): boolean {
    return this.orders !== null;
  }
}
