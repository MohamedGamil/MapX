<?php

namespace App\Shared;

use App\Domain\Money;

class Result
{
    public function run(): void
    {
        (new Money())->run();
    }
}
