<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Required by a brace-less `if (env(...)) require ...;` in routes/api.php.
Route::get('exports', [HomeController::class, 'exports']);
