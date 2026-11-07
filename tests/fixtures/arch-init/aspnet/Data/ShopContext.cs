// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Microsoft.EntityFrameworkCore;
using Shop.Models;

namespace Shop.Data;

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    public Order LoadFirst() => Orders.First();

    public int CountAll() => Orders.Count();
}
