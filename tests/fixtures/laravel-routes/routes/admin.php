<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted by RouteServiceProvider::mapAdminRoutes(), which map() calls.
Route::get('panel', [HomeController::class, 'adminPanel']);
