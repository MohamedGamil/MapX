<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Listed after a closure in one Route::prefix('mix')->group([...]) in routes/api.php.
Route::get('mixed', [HomeController::class, 'mixFile']);
