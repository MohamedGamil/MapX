<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Service;

use App\Repository\OrderRepository;

class OrderTotals
{
    public function __construct(private OrderRepository $orders)
    {
    }

    public function sum(): int
    {
        return count($this->orders->findAll());
    }
}
