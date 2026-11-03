// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Microsoft.AspNetCore.Mvc;
using Shop.Data;
using Shop.Dtos;
using Shop.Services;

namespace Shop.Controllers;

[ApiController]
[Route("orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderService _orders;
    private readonly ShopContext _db;

    public OrdersController(OrderService orders, ShopContext db)
    {
        _orders = orders;
        _db = db;
    }

    [HttpGet]
    public OrderDto Get() => _orders.GetFirstOrder();

    // Allowed: scaffolded controllers inject the DbContext (review of M5-17-R1).
    [HttpGet("count")]
    public int Total() => _db.CountAll();
}
