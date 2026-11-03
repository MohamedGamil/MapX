// Synthetic fixture for M5-17-R1 (review): C# attributes on their own lines above the declaration.
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Shop.Admin;

[Authorize]
[Route("audit")]
public class AuditController : ControllerBase
{
    public IActionResult Get() => Ok();
}
