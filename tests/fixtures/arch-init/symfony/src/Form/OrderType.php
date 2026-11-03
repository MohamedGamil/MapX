<?php
// Synthetic fixture for M5-17-R1 (mapx arch init --preset symfony). Not a real application.
namespace App\Form;

use App\Entity\Order;
use App\Repository\OrderRepository;
use Symfony\Component\Form\AbstractType;
use Symfony\Component\OptionsResolver\OptionsResolver;

class OrderType extends AbstractType
{
    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults(['data_class' => Order::class]);
    }

    // An EntityType's query_builder (review of M5-17-R1): a form may query a repository.
    public static function choices(OrderRepository $orders): array
    {
        return $orders->findAll();
    }
}
