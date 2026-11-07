<?php
namespace App\Infrastructure;

use Doctrine\DBAL\DriverManager;

class Database
{
    public function open()
    {
        return DriverManager::getConnection([]);
    }
}
