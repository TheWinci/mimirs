<?php
/** Coordinates work. */
#[Service]
class Coordinator
{
    /** Current worker. */
    private Worker $worker;

    /** Runs one unit of work. */
    #[Deprecated]
    public function run(): void
    {
        // Keep delegation visible.
        $this->worker->run();
    }
}
