//! Locale ordering shared by source relationships and retrieval.
use icu_collator::{Collator, CollatorBorrowed};
use std::{cmp::Ordering, sync::LazyLock};

// The frozen Bun reference uses English locale collation for channel ties.
static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), Default::default()).expect("compiled root collation")
});

pub fn locale_compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}
