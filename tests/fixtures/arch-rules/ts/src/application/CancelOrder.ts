import { Result } from '../shared/Result';
import { AuditTrail } from '../domain/AuditTrail';

export class CancelOrder {
  run(): void {
    new Result().run();
    new AuditTrail().run();
  }
}
