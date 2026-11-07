import { CancelOrder } from '../application/CancelOrder';
import { BaseController } from './BaseController';
import { SqlOrderRepository } from '../infrastructure/SqlOrderRepository';
import { TaxRules } from '../application/internal/TaxRules';

export class ReportController {
  run(): void {
    new CancelOrder().run();
    new BaseController().run();
    new SqlOrderRepository().run();
    new TaxRules().run();
  }
}
