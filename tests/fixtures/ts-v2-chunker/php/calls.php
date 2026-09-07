<?php
class Worker
{
    public static function create(): self { return new self(resolve()); }
}

function run(Service $service, callable $loader): void
{
    $loader();
    helper();
    Service::create();
    $service->execute();
    $service?->maybe();
    factory()->build();
    new Worker(build());
}

function helper(): void {}
