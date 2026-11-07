<?php

namespace App\Application;

use App\Shared\Result;
use App\Domain\AuditTrail;

class CancelOrder
{
    public function run(): void
    {
        (new Result())->run();
        (new AuditTrail())->run();
    }
}
