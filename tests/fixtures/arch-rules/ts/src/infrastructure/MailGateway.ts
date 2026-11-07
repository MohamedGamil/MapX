import { Order } from '../domain/Order';
import { Uuid } from '../support/Uuid';

export class MailGateway {
  run(): void {
    new Order().run();
    new Uuid().run();
  }
}
