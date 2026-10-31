<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// require_once'd under two prefixes in routes/api.php: PHP loads it the first time only.
Route::get('shared', [HomeController::class, 'onceShared']);
