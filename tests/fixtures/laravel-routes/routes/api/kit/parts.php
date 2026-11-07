<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted with tools.php as one array by the legacy Route::group(attributes, [files]) in routes/api.php.
Route::get('parts', [HomeController::class, 'kitParts']);
