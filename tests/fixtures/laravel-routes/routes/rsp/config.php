<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under Route::prefix(config('app.api_prefix')): the prefix is only known at runtime.
Route::get('settings', [HomeController::class, 'settings']);
