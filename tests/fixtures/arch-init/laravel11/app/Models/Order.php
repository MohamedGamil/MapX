<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Models;

use App\Enums\OrderStatus;
use App\Events\OrderShipped;
use App\Jobs\ProcessOrder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Order extends Model
{
    use HasFactory;

    protected $dispatchesEvents = ['updated' => OrderShipped::class];

    // Review of M5-17-R1: a model may dispatch a job from booted().
    protected static function booted(): void
    {
        static::created(fn (Order $order) => ProcessOrder::dispatch($order));
    }

    protected function casts(): array
    {
        return ['status' => OrderStatus::class];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function items()
    {
        return $this->hasMany(OrderItem::class);
    }
}
