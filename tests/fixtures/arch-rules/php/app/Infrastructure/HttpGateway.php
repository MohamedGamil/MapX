<?php

// Synthetic (M5-19): references to classes and functions outside the workspace, labelled in
// expected-externals.json.

namespace App\Infrastructure;

use GuzzleHttp\Client;
use Psr\Log\LoggerInterface;
use App\Domain\Missing;

class HttpGateway extends \Illuminate\Routing\Controller
{
    public function run(LoggerInterface $logger): void
    {
        $client = new Client();
        $client->send();
        \Carbon\Carbon::now();
        new \DateTime();
        strlen('run');
        isset($logger);
    }
}
