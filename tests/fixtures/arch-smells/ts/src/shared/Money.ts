// Shared: depends back on Domain, which its rules forbid (a violation, and a Domain/Shared cycle).
import { Order } from '../domain/Order';

export class Money {
  constructor(readonly amount: number) {}

  /** @deprecated use forOrder() */
  legacyAmount(): number {
    return this.amount;
  }

  forOrder(order: Order): string {
    return `${order.id}:${this.amount}`;
  }
}
