<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Jobs;

use App\Events\OrderShipped;
use App\Models\Order;
use App\Services\OrderTotals;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class ProcessOrder implements ShouldQueue
{
    use Queueable;

    public function __construct(public Order $order)
    {
    }

    public function handle(OrderTotals $totals): void
    {
        $totals->sum();
        OrderShipped::dispatch($this->order);
    }
}
