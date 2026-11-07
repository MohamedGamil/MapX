// Legacy: in no layer, and nothing imports it (orphan-element, the positive case). It imports UsedHelper.
import { UsedHelper } from './UsedHelper';

export class DeadHelper {
  help(): string {
    return new UsedHelper().name();
  }
}
