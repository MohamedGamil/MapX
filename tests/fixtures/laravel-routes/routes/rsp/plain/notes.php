<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted by the brace-less glob loop in RouteServiceProvider::mapProviderRoutes() with require.
Route::get('notes', [HomeController::class, 'notes']);
