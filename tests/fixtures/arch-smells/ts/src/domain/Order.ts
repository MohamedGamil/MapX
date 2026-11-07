// Domain: depends on Shared, as allowed.
import { Money } from '../shared/Money';
import { label } from '../shared/format';

export class Order {
  readonly total = new Money(0);

  constructor(readonly id: string) {}

  name(): string {
    return label(this.id);
  }
}
