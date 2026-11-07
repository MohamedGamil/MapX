<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Actions;

use App\Models\Order;

class CreateOrder
{
    public function __invoke()
    {
        return Order::create([]);
    }
}
