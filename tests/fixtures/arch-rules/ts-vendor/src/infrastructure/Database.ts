import { Pool } from 'pg';

export class Database {
  open(): Pool {
    return new Pool();
  }
}
