<?php

use App\Http\Controllers\ReportController;
use Illuminate\Support\Facades\Route;

// Mounted by the legacy Route::group(attributes, path) form in routes/api.php.
Route::get('entries', [ReportController::class, 'archive']);
