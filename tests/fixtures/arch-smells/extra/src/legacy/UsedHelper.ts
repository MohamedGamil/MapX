// Legacy: in no layer, but DeadHelper imports it, so something depends on it (orphan-element, a negative case).
export class UsedHelper {
  name(): string {
    return 'used';
  }
}
