// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.billing;

import com.example.shop.domain.Order;
import org.springframework.data.repository.CrudRepository;

// In no folder the preset names: only extending a Spring Data repository puts it in Repository.
public interface InvoiceRepository extends CrudRepository<Order, Long> {
}
