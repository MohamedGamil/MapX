<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under "ops/{$this->version}" with the provider's name prefix and domain.
Route::get('status', [HomeController::class, 'opsStatus'])->name('status');
