// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.web;

import com.example.shop.domain.Order;
import com.example.shop.dto.OrderDto;
import com.example.shop.service.OrderService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    private final OrderService orders;

    public OrderController(OrderService orders) {
        this.orders = orders;
    }

    @GetMapping("/orders/first")
    public OrderDto first() {
        return orders.first();
    }

    // Allowed: a controller maps an entity to its DTO (review of M5-17-R1).
    @GetMapping("/orders/latest")
    public OrderDto latest() {
        Order order = orders.latest();
        return OrderDto.of(order);
    }
}
