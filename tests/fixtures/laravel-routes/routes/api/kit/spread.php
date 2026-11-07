<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Spread into the list of Route::prefix('mix')->group([...]) in routes/api.php.
Route::get('spread', [HomeController::class, 'spreadFile']);
