import { Client } from 'pg';
import debounce from 'lodash/debounce';

export class Order {
  save(): Client {
    debounce(() => 0, 10);
    return new Client();
  }
}
