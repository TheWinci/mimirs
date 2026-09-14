//! Tokio unbounded channels with run cancellation and queue profiling.
use crate::profiling::{Activity, Profiler};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;
use tokio::sync::mpsc;

pub(super) trait Close: Send + Sync {
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
    pub fn register(&self, queue: Arc<dyn Close>) {
        let mut registry = self.0.lock().unwrap();
        if registry.cancelled {
            queue.close();
        }
        registry.queues.push(Arc::downgrade(&queue));
    }
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

type Envelope<T> = (T, usize, Option<Instant>);

struct State<T> {
    sender: Option<mpsc::UnboundedSender<Envelope<T>>>,
    senders: usize,
    items: usize,
    bytes: usize,
    cancelled: bool,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    profile: Profiler,
    name: &'static str,
}

impl<T: Send> Close for Shared<T> {
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.cancelled = true;
        state.sender.take();
    }
}

pub(super) struct Sender<T: Send>(Arc<Shared<T>>);
pub(super) struct Receiver<T: Send> {
    shared: Arc<Shared<T>>,
    inner: mpsc::UnboundedReceiver<Envelope<T>>,
}

pub(super) fn unbounded<T: Send + 'static>(
    name: &'static str,
    profile: &Profiler,
    cancel: &Cancel,
) -> (Sender<T>, Receiver<T>) {
    let (sender, inner) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            sender: Some(sender),
            senders: 1,
            items: 0,
            bytes: 0,
            cancelled: false,
        }),
        profile: profile.clone(),
        name,
    });
    cancel.register(shared.clone());
    (Sender(shared.clone()), Receiver { shared, inner })
}

impl<T: Send> Clone for Sender<T> {
    fn clone(&self) -> Self {
        self.0.state.lock().unwrap().senders += 1;
        Self(self.0.clone())
    }
}

impl<T: Send> Sender<T> {
    pub fn send(&self, value: T, bytes: usize) -> Result<(), T> {
        self.send_at(value, bytes, self.0.profile.queue_start())
    }

    fn send_at(&self, value: T, bytes: usize, queued: Option<Instant>) -> Result<(), T> {
        let mut state = self.0.state.lock().unwrap();
        let Some(sender) = &state.sender else {
            return Err(value);
        };
        sender
            .send((value, bytes, queued))
            .map_err(|error| error.0.0)?;
        state.items += 1;
        state.bytes += bytes;
        self.0
            .profile
            .stage_queue(self.0.name, state.items, state.bytes);
        Ok(())
    }
}

impl<T: Send> Drop for Sender<T> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.senders -= 1;
        if state.senders == 0 {
            state.sender.take();
        }
    }
}

impl<T: Send + 'static> Receiver<T> {
    pub async fn recv(&mut self) -> Option<T> {
        let wait = (self.inner.is_empty() && !self.inner.is_closed())
            .then(|| self.shared.profile.stage(self.shared.name, Activity::Input));
        // Await even for buffered messages so Tokio's cooperative scheduling
        // budget applies when a producer keeps the queue continuously nonempty.
        let value = self.inner.recv().await;
        drop(wait);
        match self.received(value) {
            Ok(value) => value,
            Err(value) => {
                let inner = std::mem::replace(&mut self.inner, mpsc::unbounded_channel().1);
                // Cancelled payloads can wait for in-flight inference on drop.
                tokio::task::spawn_blocking(move || drop((value, inner)))
                    .await
                    .expect("channel cleanup panicked");
                None
            }
        }
    }

    pub fn blocking_recv(&mut self) -> Option<T> {
        let value = match self.inner.try_recv() {
            Ok(value) => Some(value),
            Err(mpsc::error::TryRecvError::Disconnected) => None,
            Err(mpsc::error::TryRecvError::Empty) => {
                let _wait = self.shared.profile.stage(self.shared.name, Activity::Input);
                self.inner.blocking_recv()
            }
        };
        match self.received(value) {
            Ok(value) => value,
            Err(value) => {
                drop(value);
                while let Ok(value) = self.inner.try_recv() {
                    drop(value);
                }
                None
            }
        }
    }

    fn received(&mut self, value: Option<Envelope<T>>) -> Result<Option<T>, Option<Envelope<T>>> {
        let mut state = self.shared.state.lock().unwrap();
        if state.cancelled {
            state.items = 0;
            state.bytes = 0;
            return Err(value);
        }
        let Some((value, bytes, queued)) = value else {
            return Ok(None);
        };
        state.items -= 1;
        state.bytes -= bytes;
        drop(state);
        self.shared.profile.queue_end(self.shared.name, queued);
        Ok(Some(value))
    }
}

impl<T: Send> Drop for Receiver<T> {
    fn drop(&mut self) {
        self.shared.close();
    }
}

#[cfg(test)]
#[path = "../tests/unit/commands/index/channel.rs"]
mod tests;
