<?php
namespace App\Domain;

use Doctrine\DBAL\Connection;

class Order
{
    public function save(Connection $connection)
    {
        \Faker\Factory::create();
    }
}
