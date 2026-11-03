// Synthetic fixture for M5-17-R1 (mapx arch init --preset nestjs). Not a real application.
// No `.service` suffix: only @Injectable puts it in Provider.
import { Injectable } from '@nestjs/common';
import { Invoice } from './invoice';

@Injectable()
export class Billing {
  charge(invoice: Invoice): number {
    return invoice.total;
  }
}
