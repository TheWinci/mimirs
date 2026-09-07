<?php
namespace Windows;

final class ReportBook
{
    /** @var list<array{title: string, owner: ?string}> */
    private array $entries = [];

    public function add(string $title, ?string $owner): void
    {
        $this->entries[] = ['title' => $title, 'owner' => $owner];
    }

    /** @return list<string> */
    public function render(): array
    {
        return array_map(
            static fn (array $entry): string =>
                $entry['title'] . ' — ' . ($entry['owner'] ?? 'unassigned'),
            $this->entries,
        );
    }

    public function size(): int
    {
        return count($this->entries);
    }
}
