//! Sample module for chunking tests, written for this repository.

use std::collections::HashMap;
use std::fmt;

mod storage;

/// Most entries a cache holds.
pub const MAX_ENTRIES: usize = 1_000;

#[derive(Debug, Default)]
pub struct Cache {
    items: HashMap<String, String>,
}

impl Cache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The value stored for `key`.
    pub fn get(&self, key: &str) -> Option<&String> {
        self.items.get(key)
    }
}

impl fmt::Display for Cache {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "{} entries", self.items.len())
    }
}

pub trait Store {
    fn load(&self) -> Vec<String>;
}

macro_rules! entry {
    ($key:expr) => {
        $key.to_string()
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_empty() {
        assert!(Cache::new().items.is_empty());
    }
}
