// Synthetic fixture for the review of M5-24: a production package (pg) and one no manifest lists (left-pad).
import { Pool } from 'pg';
import pad from 'left-pad';

export class OrderRepository {
  save(id: string) {
    return new Pool().query('insert into orders values ($1)', [pad(id, 8)]);
  }
}
