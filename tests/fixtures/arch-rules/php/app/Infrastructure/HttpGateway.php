<?php

// Synthetic (M5-19, M5-21): references to classes and functions outside the workspace, labelled in
// expected-externals.json with the package composer.json and composer.lock attribute them to.

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
        new \PDO('sqlite::memory:');
        str_contains('run', 'r');
        new \Mustache_Engine();
        \GuzzleHttp\Psr7\Utils::streamFor('run');
        \Faker\Factory::create();
        \PHPUnit\Framework\Assert::assertTrue(true);
        \DeepCopy\deep_copy($logger);
        new \Doctrine\Instantiator\Instantiator();
        collect([]);
        new \Acme\Missing\Widget();
        \Illuminate\Support\Str::of('run');
        new \Doctrine\Common\EventManager();
    }
}
