<?php
// Synthetic fixture for M5-17-R1 (review): a folder the laravel preset names no layer for. Order casts
// to it, so without the Unclassified layer `check --fail-on-uncovered` fails on day one.
namespace App\Enums;

enum OrderStatus: string
{
    case Open = 'open';
    case Shipped = 'shipped';
}
