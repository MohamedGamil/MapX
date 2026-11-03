<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Controller;

use App\Form\OrderType;
use App\Message\OrderPlaced;
use App\Service\OrderTotals;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Routing\Attribute\Route;

class OrderController extends AbstractController
{
    #[Route('/orders')]
    public function index(OrderTotals $totals, MessageBusInterface $bus): Response
    {
        $this->createForm(OrderType::class);
        $bus->dispatch(new OrderPlaced(1));
        return new Response((string) $totals->sum());
    }
}
