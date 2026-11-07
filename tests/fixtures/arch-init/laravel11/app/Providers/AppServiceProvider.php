<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Providers;

use App\Events\OrderShipped;
use App\Listeners\SendShipmentNotification;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Event::listen(OrderShipped::class, SendShipmentNotification::class);
    }
}
