// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Shop.Models;

namespace Shop.Dtos;

public record OrderDto(int Total)
{
    public static OrderDto From(Order order) => new(order.Total);
}
