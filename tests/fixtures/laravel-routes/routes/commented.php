<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Only named by a commented-out withRouting argument in bootstrap/app.php.
Route::get('commented-entry', [HomeController::class, 'commentedEntry']);
