// Synthetic fixture (M5-09 review): extends Spring Data's AbstractPersistable, not the local one.
package com.acme.b;

import org.springframework.data.jpa.domain.AbstractPersistable;

public class Order extends AbstractPersistable<Long> {}
