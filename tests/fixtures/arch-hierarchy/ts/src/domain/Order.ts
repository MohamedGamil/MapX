// Synthetic fixture (M5-09): extends sequelize's Model through BaseModel; implements Payable through Billable.
import { BaseModel } from '../support/BaseModel';
import { Billable } from './Billable';

export class Order extends BaseModel implements Billable {
  total = 0;
  pay(): void {}
}
