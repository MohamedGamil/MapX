<?php
namespace App\Infrastructure;

class Request
{
    public function read()
    {
        $name = $_GET['name'] ?? $_POST['name'];
        $host = $_SERVER['HTTP_HOST'];
        $_SESSION['seen'] = $_COOKIE['seen'];
        $file = $_FILES['upload'];
        return [$name, $host, $file, $GLOBALS['app']];
    }

    public function environment()
    {
        return getenv('APP_ENV');
    }
}
