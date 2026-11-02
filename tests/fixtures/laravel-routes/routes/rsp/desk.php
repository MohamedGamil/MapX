<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under $desk, which is reassigned under a condition: either value is possible.
Route::get('tickets', [HomeController::class, 'deskTickets']);
