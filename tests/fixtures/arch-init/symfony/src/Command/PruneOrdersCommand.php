<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Command;

use App\Repository\OrderRepository;
use Symfony\Component\Console\Command\Command;

class PruneOrdersCommand extends Command
{
    public function __construct(private OrderRepository $orders)
    {
        parent::__construct('app:prune-orders');
    }
}
