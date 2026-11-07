<?php
// Synthetic fixture for M5-17 (mapx arch init --preset laravel): an idiomatic Laravel 11 app. Not a real application.
use Illuminate\Foundation\Application;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php', api: __DIR__.'/../routes/api.php', commands: __DIR__.'/../routes/console.php', channels: __DIR__.'/../routes/channels.php')
    ->create();
