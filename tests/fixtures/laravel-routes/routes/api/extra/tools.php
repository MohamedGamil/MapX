<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Loaded by a brace-less glob loop inside Route::prefix('extra')->group(...) in routes/api.php.
Route::get('tools', [HomeController::class, 'tools']);
