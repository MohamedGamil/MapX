// Synthetic fixture (M5-24-R2): inherits BaseRepo's pg dependency (positive).
import { BaseRepo } from '../support/BaseRepo';

export class Order extends BaseRepo {
  total = 0;
}
