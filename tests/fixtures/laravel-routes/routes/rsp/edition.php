<?php

use App\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

// Mounted under $this->edition after the method reassigns it.
Route::get('notes', [HomeController::class, 'editionNotes']);
