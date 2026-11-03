// Synthetic fixture for M5-17-R1 (mapx arch init --preset aspnet). Not a real application.
using Shop.Data;
using Shop.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<OrderService>();
builder.Services.AddDbContext<ShopContext>();
var app = builder.Build();
app.MapControllers();
app.Run();
