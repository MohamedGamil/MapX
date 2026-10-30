<?php

use App\Http\Controllers\GhostController;
use Illuminate\Support\Facades\Route;

// Nothing requires or loads this file.
Route::get('ghost', [GhostController::class, 'show']);
