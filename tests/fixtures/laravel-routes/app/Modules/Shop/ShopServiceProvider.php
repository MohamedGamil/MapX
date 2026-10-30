<?php

namespace App\Modules\Shop;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class ShopServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Route::prefix('shop')->group(function () {
            $this->loadRoutesFrom(__DIR__.'/routes.php');
        });
    }
}
