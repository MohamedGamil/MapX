// Service: uses Repository (its own "+Repository") and a deprecated Shared helper.
import { SqlRepo } from '../repository/SqlRepo';
import { legacyLabel } from '../shared/format';

export class OrderService {
  private readonly repo = new SqlRepo();

  describe(id: string): string {
    return `${legacyLabel(id)} (${this.repo.count()})`;
  }
}
