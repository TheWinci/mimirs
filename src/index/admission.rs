//! Track retained files and payload estimates across stages without admission limits.
use super::channel::{Cancel, Close};
use crate::profiling::Profiler;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    files: usize,
    bytes: usize,
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    profile: Profiler,
}

impl Close for Shared {
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
    }
}

#[derive(Clone)]
pub(super) struct Admission(Arc<Shared>);

pub(super) struct Permit {
    shared: Arc<Shared>,
    bytes: usize,
}

// Estimate the source plus expanded analysis, document/window text, vectors,
// and staging messages. This is deliberately conservative, not a hard RSS bound.
pub(super) fn estimate(source_bytes: usize, path_bytes: usize) -> usize {
    source_bytes
        .saturating_mul(64)
        .saturating_add(path_bytes.saturating_mul(64))
        .saturating_add(64 * 1024)
}

impl Admission {
    pub fn new(profile: &Profiler, cancel: &Cancel) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            profile: profile.clone(),
        });
        cancel.register(shared.clone());
        Self(shared)
    }

    pub fn acquire(&self, bytes: usize) -> Option<Permit> {
        let requested = self.0.profile.queue_start();
        let mut state = self.0.state.lock().unwrap();
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

    // Update retained-payload accounting before handing the file off.
    pub fn grow(&mut self, bytes: usize) -> bool {
        if bytes <= self.bytes {
            return true;
        }
        let requested = self.shared.profile.queue_start();
        let mut state = self.shared.state.lock().unwrap();
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
    }
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index/admission.rs"]
mod tests;
