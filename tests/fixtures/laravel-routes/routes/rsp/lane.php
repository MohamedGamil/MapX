<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted in a while loop under $lane, which the loop body reassigns after the mount: the first
// pass uses 'slow', later passes 'fast', so the prefix is not one known value.
Route::get('go', [HomeController::class, 'laneGo']);
