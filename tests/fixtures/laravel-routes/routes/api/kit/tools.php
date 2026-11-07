<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted with parts.php as one array by the legacy Route::group(attributes, [files]) in routes/api.php.
Route::get('tools', [HomeController::class, 'kitTools']);
