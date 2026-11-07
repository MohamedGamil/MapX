<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under $tier after `$tier ??= 'gold'` (undefined until then).
Route::get('perks', [HomeController::class, 'tierPerks']);
