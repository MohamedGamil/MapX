// Synthetic fixture (M5-10): Kotlin annotations and KDoc tags on symbols.
package com.acme

/**
 * An order.
 * @deprecated use OrderV2
 * @property id the id
 */
@Entity
@Table(name = "orders",
  schema = "shop")
class Order(val id: Long) {
  /**
   * Runs it.
   * @param x the x
   */
  @Deprecated("use runV2")
  @kotlin.jvm.JvmStatic
  fun run(x: Int) {}

  fun plain() {}
}
