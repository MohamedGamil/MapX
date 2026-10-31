<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted by the glob loop in RouteServiceProvider::mapProviderRoutes() with ->group($file).
Route::get('inbox', [HomeController::class, 'inbox']);
