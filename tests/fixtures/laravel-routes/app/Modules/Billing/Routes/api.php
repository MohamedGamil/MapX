<?php

use App\Modules\Billing\InvoiceController;
use Illuminate\Support\Facades\Route;

Route::get('invoices', [InvoiceController::class, 'index']);
Route::get('invoices/{invoice}', [InvoiceController::class, 'show']);
