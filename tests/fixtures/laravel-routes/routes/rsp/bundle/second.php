<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Second of the two files the RouteServiceProvider mounts as one array under 'bundle'.
Route::get('second', [HomeController::class, 'bundleSecond']);
