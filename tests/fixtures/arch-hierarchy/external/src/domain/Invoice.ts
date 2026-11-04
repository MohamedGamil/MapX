// Synthetic fixture (M5-24-R2): extends BaseRepo and also uses pg itself (negative: its own dependency is
// not derived again, so it has no `via`).
import { Pool } from 'pg';
import { BaseRepo } from '../support/BaseRepo';

export class Invoice extends BaseRepo {
  private own = new Pool();
}
