<?php
function control(array $callbacks, callable $replacement): void
{
    foreach ($callbacks as $key => $callback) {
        $key();
        $callback();
    }
    $key();
    $callback();

    foreach ($callbacks as [$left, $right]) {
        $left();
        $right();
    }
    $left();
    $right();

    for ($index = start(); check($index); advance($index)) {
        $index();
    }
    $index();

    try {
        risky();
    } catch (Throwable $failure) {
        $failure();
    }
    $failure();

    if (condition()) {
        $conditional = fn() => build();
        $conditional();
    }
    $conditional();

    $before();
    $before = fn() => build();
    $before();

    $callable = fn() => build();
    $callable();
    $callable = $replacement;
    $callable();
    unset($callable);
    $callable();

    [$first, $second] = $callbacks;
    $first();
    $second();

    global $globalCallback;
    $globalCallback();
    static $staticCallback;
    $staticCallback();
}
