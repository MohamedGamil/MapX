// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.service;

import com.example.shop.billing.Billing;
import com.example.shop.domain.Order;
import com.example.shop.dto.OrderDto;
import com.example.shop.repository.OrderRepository;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public OrderDto first() {
        Order order = repository.findAll().get(0);
        return new OrderDto(order.getTotal());
    }

    // A member of a class that only its @Service annotation places (review of M5-17-R1).
    public long invoices(Billing billing) {
        return billing.invoiceCount();
    }

    public Order latest() {
        return repository.findAll().get(0);
    }
}
