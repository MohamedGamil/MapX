<?php

use Illuminate\Foundation\Application;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    // ->withRouting(web: __DIR__.'/../routes/commented.php')
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        then: function () {
            Route::middleware('api')->prefix('webhooks')->group(base_path('routes/webhooks.php'));
        },
    )
    ->create();
