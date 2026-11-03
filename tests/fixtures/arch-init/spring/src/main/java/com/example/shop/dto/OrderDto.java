// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.dto;

import com.example.shop.domain.Order;

public record OrderDto(int total) {
    public static OrderDto of(Order order) {
        return new OrderDto(order.getTotal());
    }
}
