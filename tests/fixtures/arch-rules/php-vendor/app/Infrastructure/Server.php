<?php
namespace App\Infrastructure;

use GuzzleHttp\Client;

class Server
{
    public function start()
    {
        strlen('server');
        return new Client();
    }
}
