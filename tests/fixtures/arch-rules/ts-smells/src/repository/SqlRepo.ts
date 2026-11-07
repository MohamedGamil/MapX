// Repository: owns pg (selected and private in the configuration), so using it here is allowed.
import { Pool } from 'pg';

export class SqlRepo {
  private readonly pool = new Pool();

  count(): number {
    return this.pool.totalCount;
  }
}
