<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Required by RouteServiceProvider::mapProviderRoutes().
Route::get('required', [HomeController::class, 'required']);
