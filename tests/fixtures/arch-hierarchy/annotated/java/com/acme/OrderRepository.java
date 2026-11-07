// Synthetic fixture for M5-17-R1 (review): an annotation on its own line above the declaration.
package com.acme;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.transaction.annotation.Transactional;

@Transactional
public interface OrderRepository extends JpaRepository<Order, Long> {
}
