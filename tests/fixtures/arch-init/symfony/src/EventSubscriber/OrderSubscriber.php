<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\EventSubscriber;

use App\Service\OrderTotals;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

class OrderSubscriber implements EventSubscriberInterface
{
    public function __construct(private OrderTotals $totals)
    {
    }

    public static function getSubscribedEvents(): array
    {
        return [];
    }
}
