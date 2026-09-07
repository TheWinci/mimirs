//! Bounded, cancellable worker channels. Closing a run wakes both producers and
//! consumers; queued values are dropped outside the channel lock.
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, Weak};

use crate::profiling::{Activity, Profiler};

trait Close: Send + Sync {
    fn close(&self);
}

#[derive(Clone, Default)]
pub(super) struct Cancel(Arc<Mutex<Registry>>);

#[derive(Default)]
struct Registry {
    cancelled: bool,
    queues: Vec<Weak<dyn Close>>,
}

impl Cancel {
    pub fn cancel(&self) {
        let queues = {
            let mut state = self.0.lock().unwrap();
            state.cancelled = true;
            state
                .queues
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for queue in queues {
            queue.close();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.lock().unwrap().cancelled
    }

    pub fn guard(&self) -> Guard {
        Guard(self.clone())
    }
}

pub(super) struct Guard(Cancel);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

struct State<T> {
    values: VecDeque<(T, usize)>,
    bytes: usize,
    senders: usize,
    closed: bool,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    readable: Condvar,
    writable: Condvar,
    capacity: usize,
    profile: Profiler,
    name: &'static str,
}

impl<T: Send> Close for Shared<T> {
    fn close(&self) {
        let values = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.bytes = 0;
            std::mem::take(&mut state.values)
        };
        self.readable.notify_all();
        self.writable.notify_all();
        drop(values);
    }
}

pub(super) struct Sender<T: Send>(Arc<Shared<T>>);
pub(super) struct Receiver<T: Send>(Arc<Shared<T>>);

pub(super) fn bounded<T: Send + 'static>(
    capacity: usize,
    name: &'static str,
    profile: &Profiler,
    cancel: &Cancel,
) -> (Sender<T>, Receiver<T>) {
    assert!(capacity > 0);
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            values: VecDeque::new(),
            bytes: 0,
            senders: 1,
            closed: false,
        }),
        readable: Condvar::new(),
        writable: Condvar::new(),
        capacity,
        profile: profile.clone(),
        name,
    });
    let erased: Arc<dyn Close> = shared.clone();
    let mut registry = cancel.0.lock().unwrap();
    if registry.cancelled {
        shared.close();
    }
    registry.queues.push(Arc::downgrade(&erased));
    (Sender(shared.clone()), Receiver(shared))
}

impl<T: Send> Clone for Sender<T> {
    fn clone(&self) -> Self {
        self.0.state.lock().unwrap().senders += 1;
        Self(self.0.clone())
    }
}

impl<T: Send> Sender<T> {
    pub fn send(&self, value: T, bytes: usize) -> Result<(), T> {
        let mut state = self.0.state.lock().unwrap();
        while !state.closed && state.values.len() == self.0.capacity {
            let _wait = self.0.profile.stage(self.0.name, Activity::Output);
            state = self.0.writable.wait(state).unwrap();
        }
        if state.closed {
            return Err(value);
        }
        state.bytes += bytes;
        state.values.push_back((value, bytes));
        self.0
            .profile
            .stage_queue(self.0.name, state.values.len(), state.bytes);
        drop(state);
        self.0.readable.notify_one();
        Ok(())
    }
}

impl<T: Send> Drop for Sender<T> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().senders -= 1;
        self.0.readable.notify_all();
    }
}

impl<T: Send> Receiver<T> {
    pub fn recv(&self) -> Option<T> {
        let mut state = self.0.state.lock().unwrap();
        while !state.closed && state.values.is_empty() && state.senders != 0 {
            let _wait = self.0.profile.stage(self.0.name, Activity::Input);
            state = self.0.readable.wait(state).unwrap();
        }
        let (value, bytes) = state.values.pop_front()?;
        state.bytes -= bytes;
        drop(state);
        self.0.writable.notify_one();
        Some(value)
    }
}

impl<T: Send> Drop for Receiver<T> {
    fn drop(&mut self) {
        self.0.close();
    }
}

#[cfg(test)]
#[path = "../../../tests/unit/commands/index/channel.rs"]
mod tests;
