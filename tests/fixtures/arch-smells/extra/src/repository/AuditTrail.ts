// Repository: depends on Service, which its rules forbid. Two violations (an import and an instantiation), so
// a baseline holds two entries for Repository, and one for Shared (Money -> Order): baseline-debt by layer.
import { OrderService } from '../service/OrderService';

export class AuditTrail {
  readonly service = new OrderService();
}
