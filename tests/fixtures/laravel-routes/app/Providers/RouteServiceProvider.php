<?php

namespace App\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    public function map(): void
    {
        $this->mapAdminRoutes();
        // $this->mapLegacyRoutes();
        // Route::prefix('old')->middleware('web')->group(base_path('routes/old.php'));
    }

    protected function mapAdminRoutes(): void
    {
        Route::prefix('admin')->middleware('web')->group(base_path('routes/admin.php'));
    }

    // Nothing calls this any more: the call in map() is commented out.
    protected function mapLegacyRoutes(): void
    {
        Route::prefix('legacy')->middleware('web')->group(base_path('routes/legacy.php'));
    }
}
