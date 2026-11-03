// Synthetic fixture for M5-17-R1 (mapx arch init --preset nestjs). Not a real application.
// No `.guard` suffix: `implements CanActivate` puts it in Enhancer, and its @Injectable does not
// also put it in Provider.
import { CanActivate, Injectable } from '@nestjs/common';
import { Billing } from './billing';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly billing: Billing) {}

  canActivate(): boolean {
    return this.billing !== null;
  }
}
