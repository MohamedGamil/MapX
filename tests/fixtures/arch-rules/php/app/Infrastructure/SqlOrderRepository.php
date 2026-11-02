<?php

namespace App\Infrastructure;

use App\Domain\Order;

class SqlOrderRepository
{
    public function run(): void
    {
        (new Order())->run();
    }
}
