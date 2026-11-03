// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
// In no folder the preset names: only its base, DbContext, puts it in Data.
using Microsoft.EntityFrameworkCore;
using Shop.Models;

namespace Shop.Billing;

public class BillingContext : DbContext
{
    public DbSet<Order> Invoices => Set<Order>();
}
