// Synthetic fixture (M5-24-R2 review): a base in no layer that uses pg; its subclass in Domain answers for it.
import { Pool } from 'pg';

export abstract class CommonBase {
  protected pool = new Pool();
}
