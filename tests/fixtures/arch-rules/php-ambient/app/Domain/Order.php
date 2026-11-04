<?php
// Synthetic (M5-24-R1): ambient access, labelled in expected-externals.json.
namespace App\Domain;

class Order
{
    public function currency()
    {
        return $_ENV['CURRENCY'] ?? 'EUR';
    }
}
