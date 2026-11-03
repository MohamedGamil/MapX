<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
use App\Http\Controllers\OrderController;
use App\Http\Middleware\EnsureAdmin;
use App\Models\Order;
use Illuminate\Support\Facades\Route;

Route::get('/orders', [OrderController::class, 'index']);
Route::post('/orders', [OrderController::class, 'store'])->middleware(EnsureAdmin::class);
Route::get('/orders/{order}/total', function (Order $order) {
    return $order->total;
});
