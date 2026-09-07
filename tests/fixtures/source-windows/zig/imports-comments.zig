const std = @import("std");

const retry_delay_ms: u32 = 250;

/// Return the configured retry delay.
pub fn retryDelay() u32 {
    return retry_delay_ms;
}

// This final comment is intentionally standalone.
