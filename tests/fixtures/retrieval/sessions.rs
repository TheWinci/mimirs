/// Remove sessions whose expiry is at or before now.
fn expire_sessions(now: u64) {
    sessions.retain(|session| session.expires > now);
}

/// Reject usernames that end with a newline.
fn valid_username(name: &str) -> bool {
    !name.ends_with('\n')
}
