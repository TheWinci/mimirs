pub fn control_flow(
    source: impl Fn() -> Option<fn()>,
    values: Vec<fn()>,
    dynamic: Option<fn()>,
) {
    if let Some(selected) = source() {
        selected();
    } else {
        selected();
    }
    selected();

    while let Some(current) = source() {
        current();
    }
    current();

    for (_index, item) in values.into_iter().enumerate() {
        item();
    }
    item();

    match dynamic {
        Some(matched) if guard() => matched(),
        None => fallback(),
        _ => fallback(),
    }
    matched();

    let Some(finalized) = source() else {
        finalized();
        return;
    };
    finalized();

    let Point { callback, other: alias } = point();
    callback();
    alias();
}
