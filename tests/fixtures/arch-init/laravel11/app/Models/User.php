<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Models;

use Database\Factories\OrderFactory;
use Illuminate\Database\Eloquent\Model;

class User extends Model
{
    // Review of M5-17-R1: the default User model names its factory (`@use HasFactory<UserFactory>`).
    protected static function newFactory(): OrderFactory
    {
        return OrderFactory::new();
    }

    public function orders()
    {
        return $this->hasMany(Order::class);
    }
}
