// Synthetic fixture (M5-10): Java annotations and Javadoc tags on symbols.
package com.acme;

/**
 * An order.
 * @deprecated use
 *   OrderV2
 * @author shop
 */
@Entity
@Table(name = "orders",
       schema = "shop")
public class Order {
  @Inject private Clock clock;

  /**
   * Runs it. See {@link Runner}.
   * @param id the id
   */
  @Override
  @javax.annotation.Nullable
  @RequestMapping(value = "/orders/{id}", method = RequestMethod.GET)
  public String run(@PathVariable int id) {
    return "";
  }

  /** An overload. @param id ignored */
  @Deprecated
  public String run(String id) {
    return id;
  }

  public void plain() {}
}
