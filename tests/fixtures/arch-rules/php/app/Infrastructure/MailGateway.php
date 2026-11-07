<?php

namespace App\Infrastructure;

use App\Domain\Order;
use App\Support\Uuid;

class MailGateway
{
    public function run(): void
    {
        (new Order())->run();
        (new Uuid())->run();
    }
}
