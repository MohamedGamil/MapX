<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under "audit/$this->version" (simple interpolation of a property).
Route::get('log', [HomeController::class, 'auditLog']);
