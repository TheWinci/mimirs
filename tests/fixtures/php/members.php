<?php
class Configuration
{
    public string $name = "default", $mode;
    private static int $count = 0;
    public const FIRST = load_first(), SECOND = load_second();

    public function __construct(
        private Client $client,
        public readonly string $id = "default",
    ) {}

    public string $title {
        get => build_title();
        set => save_title($value);
    }
}
