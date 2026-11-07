<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Events;

use App\Models\Order;
use Illuminate\Foundation\Events\Dispatchable;

class OrderShipped
{
    use Dispatchable;

    public function __construct(public Order $order)
    {
    }
}
