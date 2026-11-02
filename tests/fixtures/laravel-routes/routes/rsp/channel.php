<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted inside a foreach whose loop variable is the prefix: once per value (beta, nightly),
// never under the value the variable held before the loop. Its {dynamic} label (L150) stands in
// until MapX expands loops over literal arrays into one mount per value.
Route::get('build', [HomeController::class, 'channelBuild']);
