// Synthetic fixture (M5-10): JavaScript decorators and JSDoc tags on symbols.

/**
 * A legacy store.
 * @deprecated
 */
@observable
export class Store {
  /**
   * Loads it.
   * @param {string} url where from
   * @returns {Promise<void>}
   */
  @action.bound
  @retry({
    times: 3,
  })
  load(url) {
    return url;
  }
}

/**
 * Formats a value.
 * @internal
 */
export function format(value) {
  return String(value);
}
