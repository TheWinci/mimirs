<?php
function captures(callable $outer, Service $service): void
{
    $arrow = fn() => $outer();

    $explicit = function () use (&$outer): void {
        $outer();
    };

    $missing = function (): void {
        $outer();
    };

    $reference = helper(...);
    $methodReference = $service->run(...);

    $arrow();
    $explicit();
    $missing();
}
