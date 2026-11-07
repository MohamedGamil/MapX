<?php
// Synthetic fixture (M5-09): an intermediate base class over a framework model outside the workspace.
namespace App\Support;

use Illuminate\Database\Eloquent\Model;
use App\Http\Mailer;

abstract class BaseModel extends Model implements \JsonSerializable
{
    use HasUuid;

    public function notify()
    {
        return new Mailer();
    }
}
