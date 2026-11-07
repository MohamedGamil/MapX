// Synthetic fixture for M5-17-R1 (mapx arch init --preset spring). Not a real application.
package com.example.shop.config;

import com.example.shop.service.OrderService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ShopConfig {
    @Bean
    public String shopName(OrderService orders) {
        return "shop";
    }
}
