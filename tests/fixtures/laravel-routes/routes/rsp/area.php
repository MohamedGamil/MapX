<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under $area after `$area .= '/v1'`.
Route::get('plan', [HomeController::class, 'areaPlan']);
