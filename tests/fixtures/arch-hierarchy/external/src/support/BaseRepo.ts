// Synthetic fixture (M5-24-R2): a base class that imports and uses a package, pg, and extends one of its
// classes (the inheritance itself is not derived for its subclasses).
import { Client, Pool } from 'pg';

export abstract class BaseRepo extends Client {
  protected pool = new Pool();
}
