<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset laravel). Not a real application.
// A controller outside app/Http that no route names: only its base puts it in Http.
namespace App\Billing;

use App\Http\Controllers\Controller;

class InvoiceController extends Controller
{
    public function charge(Invoice $invoice)
    {
        ChargeInvoice::dispatch($invoice);
        return $invoice;
    }
}
