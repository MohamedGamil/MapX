// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Shop.Data;
using Shop.Dtos;
using Shop.Models;

namespace Shop.Services;

public class OrderService
{
    private readonly ShopContext _db;

    public OrderService(ShopContext db) => _db = db;

    public OrderDto GetFirstOrder()
    {
        Order order = _db.LoadFirst();
        return new OrderDto(order.Total);
    }
}
