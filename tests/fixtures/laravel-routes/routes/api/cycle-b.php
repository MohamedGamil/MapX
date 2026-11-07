<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

Route::get('cycle-b', [HomeController::class, 'cycleB']);
// Both already loaded (api.php by Laravel's require): no-ops in PHP.
require_once __DIR__.'/cycle-a.php';
require_once __DIR__.'/../api.php';
