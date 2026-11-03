<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class User extends Model
{
    public function orders()
    {
        return $this->hasMany(Order::class);
    }
}
