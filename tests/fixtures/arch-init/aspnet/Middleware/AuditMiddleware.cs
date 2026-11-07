// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Microsoft.AspNetCore.Http;
using Shop.Services;

namespace Shop.Middleware;

public class AuditMiddleware
{
    private readonly RequestDelegate _next;

    public AuditMiddleware(RequestDelegate next) => _next = next;

    public Task InvokeAsync(HttpContext context, OrderService orders)
    {
        orders.GetFirstOrder();
        return _next(context);
    }
}
