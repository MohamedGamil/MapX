<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Listeners;

use App\Events\OrderShipped;
use App\Models\User;

class SendShipmentNotification
{
    public function handle(OrderShipped $event): void
    {
        User::find($event->order->user_id);
    }
}
