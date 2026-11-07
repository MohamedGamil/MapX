<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
// In no folder the preset names: only its base, AbstractController, puts it in Controller.
namespace App\Billing;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;

class InvoiceController extends AbstractController
{
    public function show(Invoice $invoice): Response
    {
        return new Response('invoice');
    }
}
