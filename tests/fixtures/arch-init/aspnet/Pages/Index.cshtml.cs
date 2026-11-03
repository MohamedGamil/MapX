// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Microsoft.AspNetCore.Mvc.RazorPages;
using Shop.Dtos;
using Shop.Services;

namespace Shop.Pages;

public class IndexModel : PageModel
{
    private readonly OrderService _orders;

    public IndexModel(OrderService orders) => _orders = orders;

    public OrderDto? Order { get; private set; }

    public void OnGet() => Order = _orders.GetFirstOrder();
}
