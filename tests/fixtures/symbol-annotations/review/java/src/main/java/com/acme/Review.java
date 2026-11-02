// Synthetic fixture (M5-10 review): Javadoc code samples and comments between annotations.
package com.acme;

/**
 * Usage:
 * <pre>
 * @Deprecated
 * void x() {}
 * </pre>
 * Or {@code
 *   @internal
 * } inline.
 * @since 2
 */
public class Review {
  @Get
  // note
  @Put
  void f() {}
}
