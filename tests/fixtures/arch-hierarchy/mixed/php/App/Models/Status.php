<?php
// Synthetic fixture (M5-09 review): an enum implementing a bare-named interface of its namespace.
namespace App\Models;

interface P {}

enum Status: string implements P
{
    case A = 'a';
}
