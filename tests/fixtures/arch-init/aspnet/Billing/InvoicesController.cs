// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
// In no folder the preset names: only its base, ControllerBase, puts it in Controllers.
using Microsoft.AspNetCore.Mvc;
using Shop.Services;

namespace Shop.Billing;

[ApiController]
public class InvoicesController : ControllerBase
{
    private readonly OrderService _orders;

    public InvoicesController(OrderService orders) => _orders = orders;
}
