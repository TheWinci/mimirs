/// Read configuration text from a file.
fn read_config(path: &str) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

/// Sort numeric samples before calculating statistics.
fn sort_samples(values: &mut [i32]) {
    values.sort();
}

/// Remove whitespace at the edges of a display label.
fn trim_label(label: &str) -> &str {
    label.trim()
}

/// Check whether a session cookie contains only printable characters.
fn valid_cookie(cookie: &str) -> bool {
    cookie.chars().all(|c| !c.is_control())
}
