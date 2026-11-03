<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\MessageHandler;

use App\Message\OrderPlaced;
use App\Repository\OrderRepository;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
class OrderPlacedHandler
{
    public function __construct(private OrderRepository $orders)
    {
    }

    public function __invoke(OrderPlaced $message): void
    {
        $this->orders->find($message->orderId);
    }
}
