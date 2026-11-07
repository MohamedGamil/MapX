<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Only mounted by a commented-out line in RouteServiceProvider::map().
Route::get('page', [HomeController::class, 'oldPage']);
