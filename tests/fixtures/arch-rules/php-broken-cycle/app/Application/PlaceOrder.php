<?php

namespace App\Application;

use App\Domain\Order;
use App\Application\Internal\PricingRules;
use App\Domain\LedgerHelper;
use App\Support\Clock;

class PlaceOrder
{
    public function run(): void
    {
        (new Order())->run();
        (new PricingRules())->run();
        (new LedgerHelper())->run();
        (new Clock())->run();
    }
}
