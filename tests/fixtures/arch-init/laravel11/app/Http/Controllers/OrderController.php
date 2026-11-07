<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Http\Controllers;

use App\Events\OrderShipped;
use App\Http\Requests\StoreOrderRequest;
use App\Jobs\ProcessOrder;
use App\Models\Order;
use App\Services\OrderTotals;

class OrderController extends Controller
{
    public function index(OrderTotals $totals)
    {
        return view('orders.index', ['orders' => Order::all(), 'sum' => $totals->sum()]);
    }

    public function store(StoreOrderRequest $request)
    {
        $order = Order::create($request->validated());
        ProcessOrder::dispatch($order);
        OrderShipped::dispatch($order);
        return $order;
    }
}
