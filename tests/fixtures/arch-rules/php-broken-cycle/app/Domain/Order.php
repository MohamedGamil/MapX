<?php

namespace App\Domain;

use App\Infrastructure\SqlOrderRepository;
use App\Domain\Ids\OrderId;

class Order
{
    public function run(): void
    {
        (new SqlOrderRepository())->run();
        (new Money())->run();
        (new OrderId())->run();
        (new LedgerHelper())->run();
    }
}
