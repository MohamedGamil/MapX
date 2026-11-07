<?php

namespace App\Modules\Billing;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class BillingServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Route::prefix('api/billing/v1')->middleware('api')->group(__DIR__.'/Routes/api.php');
    }
}
