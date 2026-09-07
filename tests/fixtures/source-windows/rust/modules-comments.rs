use std::time::Duration;

const RETRY_DELAY: Duration = Duration::from_millis(250);

/// Return the configured retry delay.
pub fn retry_delay() -> Duration {
    RETRY_DELAY
}

// This final comment is intentionally standalone.
