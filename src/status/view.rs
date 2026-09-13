use super::*;
use serde_json::{Value, json};

pub(super) fn lease(root: &Path, active: &Active, time: u64) -> (&'static str, &'static str) {
    let Ok(id) = uuid::Uuid::parse_str(&active.id) else {
        return ("unknown", "invalid process instance");
    };
    let path = root.join(".mimirs/status-owners").join(id.to_string());
    let file = match fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ("stopped", "observation lease is absent");
        }
        Err(_) => return ("unknown", "observation lease cannot be inspected"),
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = file.unlock();
            ("stopped", "observation owner exited or was interrupted")
        }
        Err(std::fs::TryLockError::WouldBlock)
            if time.saturating_sub(active.heartbeat_at) <= LIVE_AGE_MS
                && active.heartbeat_at <= time.saturating_add(1000) =>
        {
            (
                "observed_active",
                "owner lease held and recent heartbeat; not an index ownership or freshness guarantee",
            )
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            ("unknown", "heartbeat expired; activity may be stalled")
        }
        Err(_) => ("unknown", "observation lease cannot be inspected"),
    }
}
pub(crate) fn read(root: &Path, time: u64) -> Value {
    let root = root.canonicalize().unwrap_or_else(|_| root.into());
    let (snapshot, diagnostic, present) = match load(&root) {
        Ok(Some(s)) => (s, None, true),
        Ok(None) => (Snapshot::new(&root), None, false),
        Err(e) => (
            Snapshot::new(&root),
            Some(bounded(&e.to_string(), 384)),
            false,
        ),
    };
    let mut value = json!(snapshot);
    value["observed_at"] = json!(time);
    value["updated_utc"] = json!(utc(snapshot.updated_at));
    value["snapshot"] = json!(if diagnostic.is_some() {
        "unavailable"
    } else if present {
        "saved"
    } else {
        "missing"
    });
    value["diagnostic"] = json!(diagnostic);
    value["contract"] = json!(
        "Saved operation results are historical. Activity requires a held observation lease and a recent heartbeat. Status does not prove source freshness, index ownership or claim truth."
    );
    for (role, active) in &snapshot.activities {
        let (state, basis) = lease(&root, active, time);
        value["activities"][role]["state"] = json!(state);
        value["activities"][role]["basis"] = json!(basis);
        value["activities"][role]["heartbeat_age_ms"] =
            json!(time.saturating_sub(active.heartbeat_at));
    }
    // Reuse the same OS-backed writer lock used by index/watch, without creating it.
    value["index_writer"] = json!(match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join(".mimirs/index.lock"))
    {
        Ok(file) => match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                "not_held_at_observation"
            }
            Err(std::fs::TryLockError::WouldBlock) => "held_at_observation",
            Err(_) => "unknown",
        },
        Err(_) => "unknown",
    });
    value
}
pub(crate) fn utc(ms: u64) -> String {
    if ms == 0 {
        return "not recorded".into();
    }
    let seconds = ms / 1000;
    let z = (seconds / 86400) as i64 + 719468;
    let era = z / 146097;
    let day = z - era * 146097;
    let year = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let doy = day - (365 * year + year / 4 - year / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = year + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}
