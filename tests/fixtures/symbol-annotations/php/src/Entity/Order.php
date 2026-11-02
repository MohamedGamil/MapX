<?php
// Synthetic fixture (M5-10): PHP attributes and PHPDoc tags on symbols.
namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Routing\Attribute\Route;

/**
 * An order.
 * @internal
 * @deprecated since 2.0, use
 *   OrderV2 instead
 */
#[ORM\Entity(repositoryClass: OrderRepository::class)]
#[ORM\Table(
    name: 'orders',
    schema: 'shop'
)]
class Order
{
    #[ORM\Column]
    private int $id;

    /**
     * Runs it. See {@link Runner} for details.
     * @Route("/legacy")
     * @return void
     */
    #[Route('/orders/{id}', methods: ['GET']), \Deprecated]
    public function run(): void
    {
    }

    public function plain(): void
    {
    }
}
