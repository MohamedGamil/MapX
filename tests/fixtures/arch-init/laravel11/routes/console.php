<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
use App\Jobs\ProcessOrder;
use App\Models\Order;
use Illuminate\Support\Facades\Schedule;

Schedule::job(new ProcessOrder(Order::first()))->daily();
