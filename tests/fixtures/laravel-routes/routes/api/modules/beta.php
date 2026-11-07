<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Loaded by foreach (glob(__DIR__.'/api/modules/*.php') as $moduleFile) in routes/api.php.
Route::get('beta-module', [HomeController::class, 'betaModule']);
