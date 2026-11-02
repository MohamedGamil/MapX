// Synthetic fixture (M5-10 review): TS doc and decorator edge cases.

/** @deprecated old doc */
// eslint-disable-next-line
export function lostDoc() {}

/** @internal a constant's doc */
const LIMIT = 1;
function notDocumented() {}

/** @deprecated overload doc */
export function over(a: string): void;
/** @since 2 */
export function over(a: number): void;
export function over(a: any) {}

class Ctl {
  @Get(':id')
  // returns one
  @UseGuards(AuthGuard)
  find(id: string) {}

  /**
   * Example:
   * @example
   * @internal
   * class Foo {}
   */
  ex() {}
}
