<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Entity;

use App\Repository\OrderRepository;
use App\Service\OrderTotals;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: OrderRepository::class)]
class Order
{
    #[ORM\Id]
    #[ORM\Column]
    private ?int $id = null;

    // The violation: the entity reaches up into a service.
    public function total(OrderTotals $totals): int
    {
        return $totals->sum();
    }
}
