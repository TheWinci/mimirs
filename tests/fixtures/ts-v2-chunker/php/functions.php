<?php
function clean(string $value): string
{
    return trim($value);
}

function transform(array $items, callable $loader): array
{
    $normalize = fn(string $value) => clean($value);
    $normalize(" value ");

    $map = function (string $value) use ($loader): string {
        return $loader($value);
    };
    $map("value");

    return array_map($normalize, $items);
}
