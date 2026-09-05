//! File docs.
#![allow(dead_code)]
// Section.
/// Item docs.
#[cfg(test)]
// Gap.

fn item() {
    //! Inner docs.
    /* nested /* comment */ here */
} // Trailing.
/** Other docs. */
#[path = "missing.rs"]
mod other;
