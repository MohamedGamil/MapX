// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.domain;

import com.example.shop.dto.OrderDto;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Order {
    @Id
    private Long id;
    private int total;

    public int getTotal() {
        return total;
    }

    // The violation: the entity builds a DTO of the web API.
    public OrderDto toDto() {
        return new OrderDto(total);
    }
}
