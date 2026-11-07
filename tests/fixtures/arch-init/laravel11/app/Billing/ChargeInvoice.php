<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset laravel). Not a real application.
// A queued job outside app/Jobs: only `implements ShouldQueue` puts it in Jobs.
namespace App\Billing;

use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class ChargeInvoice implements ShouldQueue
{
    use Queueable;

    public function __construct(public Invoice $invoice)
    {
    }

    public function handle(): void
    {
    }
}
