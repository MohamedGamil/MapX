<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// First of the two files the RouteServiceProvider mounts as one array under 'bundle'.
Route::get('first', [HomeController::class, 'bundleFirst']);
