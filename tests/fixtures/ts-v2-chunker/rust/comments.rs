//! Utilities for the crate.

/// Stores the current version.
pub const VERSION: usize = 1;

/// Checks service health.
#[inline]
pub fn ping() -> bool {
    // Keep the health check centralized.
    check()
}
