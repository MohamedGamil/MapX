<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Required with a DIRECTORY_SEPARATOR-built path in routes/api.php.
Route::get('separator', [HomeController::class, 'separator']);
