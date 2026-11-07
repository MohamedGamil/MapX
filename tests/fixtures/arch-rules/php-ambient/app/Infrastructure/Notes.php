<?php
namespace App\Infrastructure;

// Only the $GLOBALS in the double-quoted string is ambient access (PHP reads it interpolated). A
// single-quoted string, an escaped \$_GET and a comment only name a superglobal, and getenv() on an
// object is a method.
class Notes
{
    public function text()
    {
        $single = '$GLOBALS and $_POST';
        $double = "the \$_GET array and $GLOBALS";
        return $single . $double . $this->getenv('X');
    }

    public function getenv($name)
    {
        return $name;
    }
}
