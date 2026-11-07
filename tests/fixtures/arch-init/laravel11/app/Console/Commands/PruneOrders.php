<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Console\Commands;

use App\Models\Order;
use Illuminate\Console\Command;

class PruneOrders extends Command
{
    protected $signature = 'orders:prune';

    public function handle(): void
    {
        Order::query()->delete();
    }
}
