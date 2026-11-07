<?php

namespace App\Controller;

use App\Application\PlaceOrder;
use App\Domain\Order;
use App\Application\Internal\PricingRules;

class OrderController
{
    public function run(): void
    {
        (new PlaceOrder())->run();
        (new BaseController())->run();
        (new Order())->run();
        (new PricingRules())->run();
    }
}
