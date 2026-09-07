<?php
namespace Fixtures\Types;

trait Logs
{
    public function log(): void { write_log(); }
}

interface Runner
{
    public function run(string $value): string;
}

enum State: string
{
    case Ready = "ready";
    case Done = "done";

    public function label(): string { return format($this->value); }
}

readonly class Worker implements Runner
{
    use Logs;

    public function run(string $value): string { return transform($value); }
}
