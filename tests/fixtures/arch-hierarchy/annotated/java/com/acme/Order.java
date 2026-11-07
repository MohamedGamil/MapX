// Synthetic fixture for M5-17-R1 (review): annotations spanning lines, and a doc comment that names
// a class, above a base list that wraps.
package com.acme;

import java.io.Serializable;
import org.springframework.data.jpa.domain.AbstractPersistable;

/**
 * Not the declaration: the class Order extends nothing here.
 */
@jakarta.persistence.Table(
    name = "orders"
)
@jakarta.persistence.Entity
public class Order
    extends AbstractPersistable<Long>
    implements Serializable {
}
