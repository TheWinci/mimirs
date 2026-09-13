//! One reservation follows a file through every stage and reorder buffer.
use super::channel::{Cancel, Close};
use crate::profiling::{Activity, Profiler};
use std::sync::{Arc, Condvar, Mutex};

pub(super) const PAYLOAD_TARGET: usize = 32 * 1024 * 1024;

#[derive(Default)]
struct State {
    files: usize,
    bytes: usize,
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    limit: usize,
    profile: Profiler,
}

impl Close for Shared {
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.changed.notify_all();
    }
}

#[derive(Clone)]
pub(super) struct Admission(Arc<Shared>);

pub(super) struct Permit {
    shared: Arc<Shared>,
    bytes: usize,
}

// Reserve for the source plus expanded analysis, document/window text, vectors,
// and staging messages. This is deliberately conservative, not a hard RSS bound.
pub(super) fn estimate(source_bytes: usize, path_bytes: usize) -> usize {
    source_bytes
        .saturating_mul(64)
        .saturating_add(path_bytes.saturating_mul(64))
        .saturating_add(64 * 1024)
}

impl Admission {
    pub fn new(limit: usize, profile: &Profiler, cancel: &Cancel) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            changed: Condvar::new(),
            limit,
            profile: profile.clone(),
        });
        cancel.register(shared.clone());
        profile.count("index_queue_file_limit", limit);
        profile.count("index_queue_payload_target_bytes", PAYLOAD_TARGET);
        Self(shared)
    }

    pub fn acquire(&self, bytes: usize) -> Option<Permit> {
        let requested = self.0.profile.queue_start();
        let mut state = self.0.state.lock().unwrap();
        while !state.closed
            && (state.files == self.0.limit
                || (state.files != 0 && state.bytes.saturating_add(bytes) > PAYLOAD_TARGET))
        {
            let _wait = self.0.profile.stage("source", Activity::Output);
            state = self.0.changed.wait(state).unwrap();
        }
        if state.closed {
            return None;
        }
        state.files += 1;
        self.0.profile.queue_end("admission", requested);
        state.bytes = state.bytes.saturating_add(bytes);
        self.0
            .profile
            .maximum("index_queue_peak_files", state.files);
        self.0
            .profile
            .maximum("index_queue_peak_payload_bytes", state.bytes);
        self.0
            .profile
            .stage_queue("admission", state.files, state.bytes);
        Some(Permit {
            shared: self.0.clone(),
            bytes,
        })
    }
}

impl Permit {
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    // Only the single parser may enlarge a reservation, before handing it off.
    // Earlier files can drain while a source that grew since stat waits here.
    pub fn grow(&mut self, bytes: usize) -> bool {
        if bytes <= self.bytes {
            return true;
        }
        let requested = self.shared.profile.queue_start();
        let mut state = self.shared.state.lock().unwrap();
        while !state.closed && state.files > 1 && state.bytes - self.bytes + bytes > PAYLOAD_TARGET
        {
            let _wait = self.shared.profile.stage("source", Activity::Output);
            state = self.shared.changed.wait(state).unwrap();
        }
        if state.closed {
            return false;
        }
        state.bytes = state.bytes - self.bytes + bytes;
        self.shared.profile.queue_end("admission_growth", requested);
        self.bytes = bytes;
        self.shared
            .profile
            .maximum("index_queue_peak_payload_bytes", state.bytes);
        self.shared
            .profile
            .stage_queue("admission", state.files, state.bytes);
        true
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.files -= 1;
        state.bytes -= self.bytes;
        drop(state);
        self.shared.changed.notify_all();
    }
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index/admission.rs"]
mod tests;
