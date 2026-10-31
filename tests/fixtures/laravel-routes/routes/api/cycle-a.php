<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Required by routes/api.php; requires cycle-b.php, which requires this file back.
Route::get('cycle-a', [HomeController::class, 'cycleA']);
require __DIR__.'/cycle-b.php';
