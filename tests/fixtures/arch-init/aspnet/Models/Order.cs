// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Shop.Services;

namespace Shop.Models;

public class Order
{
    public int Id { get; set; }
    public int Total { get; set; }

    // The violation: a model reaches up into a service.
    public int Rebate(OrderService pricing) => pricing.GetFirstOrder().Total;
}
