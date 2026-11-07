<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Loaded by $this->loadRoutesFrom() in RouteServiceProvider::mapProviderRoutes().
Route::get('loaded', [HomeController::class, 'loaded']);
