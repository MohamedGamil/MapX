<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
use App\Actions\CreateOrder;
use Illuminate\Support\Facades\Route;

Route::post('/orders', CreateOrder::class);
