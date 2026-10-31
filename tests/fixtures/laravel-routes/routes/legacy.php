<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Only mounted by RouteServiceProvider::mapLegacyRoutes(), which nothing calls.
Route::get('page', [HomeController::class, 'legacyPage']);
