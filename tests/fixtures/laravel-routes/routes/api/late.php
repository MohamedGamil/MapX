<?php

use App\Http\Controllers\PostController;
use Illuminate\Support\Facades\Route;

// Registered after routes/api.php declares GET dup, so this one wins.
Route::get('dup', [PostController::class, 'newDup']);
