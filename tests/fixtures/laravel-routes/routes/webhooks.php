<?php

use App\Http\Controllers\WebhookController;
use Illuminate\Support\Facades\Route;

// Mounted by withRouting(then: ...) in bootstrap/app.php.
Route::post('stripe', [WebhookController::class, 'stripe']);
