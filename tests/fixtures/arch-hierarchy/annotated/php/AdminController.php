<?php
// Synthetic fixture for M5-17-R1 (review): PHP attributes above the declaration, one spanning lines.
namespace App\Admin;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/admin')]
class AdminController extends AbstractController
{
}

#[ORM\Entity(
    repositoryClass: ProductRepository::class
)]
class Product extends \Doctrine\Common\Model
{
}
