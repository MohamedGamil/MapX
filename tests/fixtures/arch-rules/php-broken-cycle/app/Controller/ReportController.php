<?php

namespace App\Controller;

use App\Application\CancelOrder;
use App\Infrastructure\SqlOrderRepository;
use App\Application\Internal\TaxRules;

class ReportController
{
    public function run(): void
    {
        (new CancelOrder())->run();
        (new BaseController())->run();
        (new SqlOrderRepository())->run();
        (new TaxRules())->run();
    }
}
