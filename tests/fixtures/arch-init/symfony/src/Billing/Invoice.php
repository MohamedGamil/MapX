<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
// In no folder the preset names: only #[ORM\Entity] puts it in Entity.
namespace App\Billing;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Invoice
{
    #[ORM\Id]
    #[ORM\Column]
    private ?int $id = null;
}
