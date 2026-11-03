<?php
// Synthetic fixture (M5-09 review): a Support base that imports and instantiates Mailer.
namespace App\Support;

use App\Http\Mailer;

class Base
{
    public function mail()
    {
        return new Mailer();
    }
}
