<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Message;

final class OrderPlaced
{
    public function __construct(public readonly int $orderId)
    {
    }
}
