<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under a partly dynamic prefix and name prefix.
Route::get('map', [HomeController::class, 'zoneMap'])->name('map');
