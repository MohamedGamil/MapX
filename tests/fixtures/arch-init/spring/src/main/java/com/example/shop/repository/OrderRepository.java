// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.repository;

import com.example.shop.domain.Order;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findAll();
}
