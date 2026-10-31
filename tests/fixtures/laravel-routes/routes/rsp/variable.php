<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted through a local variable: ->group($routes).
Route::get('page', [HomeController::class, 'variablePage']);
