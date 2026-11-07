<?php

use App\Http\Controllers\BetaController;
use Illuminate\Support\Facades\Route;

Route::get('beta/feature', [BetaController::class, 'show']);
