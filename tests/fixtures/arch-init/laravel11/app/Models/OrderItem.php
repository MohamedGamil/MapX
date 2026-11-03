<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Models;

use App\Http\Requests\StoreOrderRequest;
use Illuminate\Database\Eloquent\Model;

class OrderItem extends Model
{
    public function order()
    {
        return $this->belongsTo(Order::class);
    }

    public static function rules(): array
    {
        return (new StoreOrderRequest())->rules();
    }
}
