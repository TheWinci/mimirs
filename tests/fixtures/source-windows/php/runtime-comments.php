<?php
require_once __DIR__ . '/bootstrap.php';

const RETRY_DELAY_MS = 250;

/** Return the configured retry delay. */
function retry_delay(): int
{
    return RETRY_DELAY_MS;
}

// This final comment is intentionally standalone.
