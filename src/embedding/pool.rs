//! Persistent singleton-inference workers. The indexing coordinator bounds the
//! number and retained bytes of submitted files; workers never access SQLite.
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::profiling::{Activity, Profiler};

use anyhow::{Context, Result, anyhow, ensure};

struct State {
    next: usize,
    active: usize,
    calls: usize,
    cancelled: bool,
    error: Option<anyhow::Error>,
    vectors: Vec<Option<Vec<f32>>>,
}

struct Work {
    queued: Option<Instant>,
    texts: Arc<Vec<String>>,
    state: Mutex<State>,
    changed: Condvar,
}

pub(crate) struct Job(Arc<Work>);

impl Job {
    pub(crate) fn inputs(&self) -> Arc<Vec<String>> {
        self.0.texts.clone()
    }

    pub(crate) fn ready(&self) -> bool {
        let state = self.0.state.lock().unwrap();
        state.active == 0 && (state.cancelled || state.next == self.0.texts.len())
    }

    pub(crate) fn wait(&mut self) -> Result<Vec<Vec<f32>>> {
        let mut state = self.0.state.lock().unwrap();
        while state.active != 0 || (!state.cancelled && state.next != self.0.texts.len()) {
            state = self.0.changed.wait(state).unwrap();
        }
        if let Some(error) = state.error.take() {
            return Err(error);
        }
        ensure!(!state.cancelled, "embedding job cancelled");
        std::mem::take(&mut state.vectors)
            .into_iter()
            .map(|v| v.context("embedding workers returned incomplete results"))
            .collect()
    }

    pub(crate) fn cancel(&self) {
        self.0.state.lock().unwrap().cancelled = true;
        self.0.changed.notify_all();
    }

    pub(crate) fn calls(&self) -> usize {
        self.0.state.lock().unwrap().calls
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Default)]
struct Queue {
    stopped: bool,
    jobs: VecDeque<Arc<Work>>,
    items: usize,
    bytes: usize,
}

#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
    profile: Profiler,
}

pub(crate) struct Pool {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Pool {
    #[cfg(test)]
    pub(crate) fn new<W: Send + 'static>(
        workers: Vec<W>,
        operation: impl Fn(&mut W, &str) -> Result<Vec<f32>> + Send + Sync + 'static,
    ) -> Result<Self> {
        Self::profiled(workers, Profiler::default(), operation)
    }

    pub(crate) fn profiled<W: Send + 'static>(
        workers: Vec<W>,
        profile: Profiler,
        operation: impl Fn(&mut W, &str) -> Result<Vec<f32>> + Send + Sync + 'static,
    ) -> Result<Self> {
        ensure!(!workers.is_empty(), "embedding needs at least one worker");
        let mut pool = Self {
            shared: Arc::new(Shared {
                profile,
                ..Shared::default()
            }),
            threads: Vec::new(),
        };
        let operation = Arc::new(operation);
        for mut worker in workers {
            let shared = pool.shared.clone();
            let operation = operation.clone();
            pool.threads.push(
                std::thread::Builder::new()
                    .name("mimirs-embedding".into())
                    .spawn(move || {
                        while let Some((job, ordinal)) = next(&shared) {
                            let active = shared.profile.stage("inference", Activity::Active);
                            let result = catch_unwind(AssertUnwindSafe(|| {
                                operation(&mut worker, &job.texts[ordinal])
                                    .with_context(|| format!("embedding chunk {ordinal}"))
                            }))
                            .unwrap_or_else(|_| Err(anyhow!("embedding worker panicked")));
                            drop(active);
                            shared.profile.stage_items("inference", 1);
                            let mut state = job.state.lock().unwrap();
                            state.active -= 1;
                            match result {
                                Ok(vector) => state.vectors[ordinal] = Some(vector),
                                Err(error) => {
                                    if state.error.is_none() {
                                        state.error = Some(error);
                                    }
                                    state.cancelled = true;
                                }
                            }
                            job.changed.notify_all();
                        }
                    })
                    .context("cannot start embedding worker")?,
            );
        }
        Ok(pool)
    }

    pub(crate) fn submit(&self, texts: Vec<String>) -> Job {
        let count = texts.len();
        let mut work = Work {
            queued: None,
            texts: Arc::new(texts),
            state: Mutex::new(State {
                next: 0,
                active: 0,
                calls: 0,
                cancelled: false,
                error: None,
                vectors: vec![None; count],
            }),
            changed: Condvar::new(),
        };
        let mut queue = self.shared.queue.lock().unwrap();
        work.queued = self.shared.profile.queue_start();
        let job = Arc::new(work);
        if count != 0 {
            queue.items += count;
            queue.bytes += job
                .texts
                .iter()
                .map(|s| s.len() + crate::embedding::DIMENSION * 4)
                .sum::<usize>();
            queue.jobs.push_back(job.clone());
            self.shared
                .profile
                .stage_queue("inference", queue.items, queue.bytes);
            drop(queue);
            self.shared.changed.notify_all();
        }
        Job(job)
    }
}

fn next(shared: &Shared) -> Option<(Arc<Work>, usize)> {
    let mut queue = shared.queue.lock().unwrap();
    loop {
        if queue.stopped {
            return None;
        }
        if let Some(job) = queue.jobs.front().cloned() {
            let mut state = job.state.lock().unwrap();
            if state.cancelled {
                queue.items -= job.texts.len() - state.next;
                queue.bytes -= job.texts[state.next..]
                    .iter()
                    .map(|s| s.len() + crate::embedding::DIMENSION * 4)
                    .sum::<usize>();
                queue.jobs.pop_front();
                job.changed.notify_all();
                continue;
            }
            let ordinal = state.next;
            queue.items -= 1;
            queue.bytes -= job.texts[ordinal].len() + crate::embedding::DIMENSION * 4;
            state.next += 1;
            state.active += 1;
            state.calls += 1;
            if state.next == job.texts.len() {
                queue.jobs.pop_front();
            }
            drop(state);
            shared.profile.queue_end("inference", job.queued);
            return Some((job, ordinal));
        }
        let idle = shared.profile.stage("inference", Activity::Input);
        queue = shared.changed.wait(queue).unwrap();
        drop(idle);
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        {
            let mut queue = self.shared.queue.lock().unwrap();
            queue.stopped = true;
            for job in queue.jobs.drain(..) {
                job.state.lock().unwrap().cancelled = true;
                job.changed.notify_all();
            }
        }
        self.shared.changed.notify_all();
        for thread in self.threads.drain(..) {
            // In-flight inference finishes before the model sessions are dropped.
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/embedding/pool.rs"]
mod tests;
