<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Services;

use App\Models\Order;

class OrderTotals
{
    public function sum(): int
    {
        return (int) Order::sum('total');
    }
}
