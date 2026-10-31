<?php

use App\Http\Controllers\ReportController;
use Illuminate\Support\Facades\Route;

// Mounted by Route::group([...], fn () => require ...) in routes/api.php.
Route::get('reports', [ReportController::class, 'index']);
