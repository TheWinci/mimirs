//! Optional local index measurements. Nested scopes contribute exclusive time.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;
use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Default)]
pub struct Profiler(Option<Arc<Mutex<State>>>);

struct State {
    start: Instant,
    stack: HashMap<ThreadId, Vec<Frame>>,
    stages: BTreeMap<&'static str, StageReport>,
    phases: BTreeMap<&'static str, f64>,
    counters: BTreeMap<&'static str, u64>,
    batch_sizes: BTreeMap<usize, u64>,
    files: Vec<FileReport>,
    current_file: Option<FileReport>,
}

struct Frame {
    name: &'static str,
    start: Instant,
    children: f64,
}

#[derive(Default, Serialize)]
pub struct FileReport {
    path: String,
    language: String,
    wall_seconds: f64,
    phases_seconds: BTreeMap<&'static str, f64>,
    counters: BTreeMap<&'static str, u64>,
}

#[derive(Serialize)]
pub struct Report {
    pub version: u32,
    pub complete: bool,
    pub error: Option<String>,
    pub wall_seconds: f64,
    pub phases_seconds: BTreeMap<&'static str, f64>,
    pub stages: BTreeMap<&'static str, StageReport>,
    pub unassigned_seconds: f64,
    pub counters: BTreeMap<&'static str, u64>,
    pub embedding_batch_sizes: BTreeMap<usize, u64>,
    pub files: Vec<FileReport>,
    pub model: String,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub available_parallelism: Option<usize>,
    pub thread_environment: BTreeMap<&'static str, String>,
}

#[derive(Clone, Default, Serialize)]
pub struct StageReport {
    pub active_seconds: f64,
    pub input_wait_seconds: f64,
    pub output_wait_seconds: f64,
    pub items: u64,
    pub peak_queued_items: usize,
    pub peak_queued_bytes: usize,
}

#[derive(Clone, Copy)]
pub enum Activity {
    Active,
    Input,
    Output,
}

pub struct StageScope {
    profile: Profiler,
    name: &'static str,
    activity: Activity,
    start: Option<Instant>,
}

pub struct Scope(Profiler, ThreadId);
pub struct FileScope {
    profile: Profiler,
    start: Option<Instant>,
    parent: Option<Profiler>,
}

impl Profiler {
    pub fn enabled() -> Self {
        Self(Some(Arc::new(Mutex::new(State {
            start: Instant::now(),
            stack: HashMap::new(),
            stages: BTreeMap::new(),
            phases: BTreeMap::new(),
            counters: BTreeMap::new(),
            batch_sizes: BTreeMap::new(),
            files: Vec::new(),
            current_file: None,
        }))))
    }

    pub fn scope(&self, name: &'static str) -> Scope {
        if let Some(state) = &self.0 {
            state
                .lock()
                .unwrap()
                .stack
                .entry(std::thread::current().id())
                .or_default()
                .push(Frame {
                    name,
                    start: Instant::now(),
                    children: 0.0,
                });
        }
        Scope(self.clone(), std::thread::current().id())
    }

    pub fn stage(&self, name: &'static str, activity: Activity) -> StageScope {
        StageScope {
            profile: self.clone(),
            name,
            activity,
            start: self.0.as_ref().map(|_| Instant::now()),
        }
    }

    pub fn stage_items(&self, name: &'static str, items: usize) {
        if let Some(state) = &self.0 {
            state.lock().unwrap().stages.entry(name).or_default().items += items as u64;
        }
    }

    pub fn stage_queue(&self, name: &'static str, items: usize, bytes: usize) {
        if let Some(state) = &self.0 {
            let mut state = state.lock().unwrap();
            let stage = state.stages.entry(name).or_default();
            stage.peak_queued_items = stage.peak_queued_items.max(items);
            stage.peak_queued_bytes = stage.peak_queued_bytes.max(bytes);
        }
    }

    pub fn measure<T>(&self, name: &'static str, operation: impl FnOnce() -> T) -> T {
        let _scope = self.scope(name);
        operation()
    }

    pub fn count(&self, name: &'static str, amount: usize) {
        if let Some(state) = &self.0 {
            let mut state = state.lock().unwrap();
            *state.counters.entry(name).or_default() += amount as u64;
            if let Some(file) = &mut state.current_file {
                *file.counters.entry(name).or_default() += amount as u64;
            }
        }
    }

    pub fn maximum(&self, name: &'static str, value: usize) {
        if let Some(state) = &self.0 {
            let mut state = state.lock().unwrap();
            let counter = state.counters.entry(name).or_default();
            *counter = (*counter).max(value as u64);
        }
    }

    pub fn batch(&self, size: usize) {
        self.count("embedding_calls", 1);
        self.count("embedding_documents", size);
        if let Some(state) = &self.0 {
            *state.lock().unwrap().batch_sizes.entry(size).or_default() += 1;
        }
    }

    pub fn file(&self, path: &str) -> FileScope {
        let start = self.0.as_ref().map(|state| {
            let mut state = state.lock().unwrap();
            assert!(state.current_file.is_none());
            state.current_file = Some(FileReport {
                path: path.into(),
                language: crate::analysis::language::for_path(path).identity.into(),
                ..FileReport::default()
            });
            Instant::now()
        });
        FileScope {
            profile: self.clone(),
            start,
            parent: None,
        }
    }

    /// File preparation and completion may interleave. Each file keeps its own
    /// coordinator scopes; completed measurements merge into the run report.
    pub fn fork_file(&self, path: &str) -> (Profiler, FileScope) {
        let child = if self.0.is_some() {
            Self::enabled()
        } else {
            Self::default()
        };
        let mut scope = child.file(path);
        scope.parent = Some(self.clone());
        (child, scope)
    }

    fn merge(&self, report: Report) {
        if let Some(state) = &self.0 {
            let mut state = state.lock().unwrap();
            for (key, value) in report.phases_seconds {
                *state.phases.entry(key).or_default() += value;
            }
            for (key, value) in report.counters {
                *state.counters.entry(key).or_default() += value;
            }
            for (key, value) in report.embedding_batch_sizes {
                *state.batch_sizes.entry(key).or_default() += value;
            }
            for (key, value) in report.stages {
                let stage = state.stages.entry(key).or_default();
                stage.active_seconds += value.active_seconds;
                stage.input_wait_seconds += value.input_wait_seconds;
                stage.output_wait_seconds += value.output_wait_seconds;
                stage.items += value.items;
                stage.peak_queued_items = stage.peak_queued_items.max(value.peak_queued_items);
                stage.peak_queued_bytes = stage.peak_queued_bytes.max(value.peak_queued_bytes);
            }
            state.files.extend(report.files);
        }
    }

    /// Finish only after all scopes have dropped. Serialization is outside the timing.
    pub fn finish(&self, error: Option<String>) -> Option<Report> {
        let state = self.0.as_ref()?;
        let mut state = state.lock().unwrap();
        assert!(state.stack.values().all(Vec::is_empty) && state.current_file.is_none());
        let wall_seconds = state.start.elapsed().as_secs_f64();
        let unassigned_seconds = (wall_seconds - state.phases.values().sum::<f64>()).max(0.0);
        Some(Report {
            version: 2,
            complete: error.is_none(),
            error,
            wall_seconds,
            phases_seconds: std::mem::take(&mut state.phases),
            stages: std::mem::take(&mut state.stages),
            unassigned_seconds,
            counters: std::mem::take(&mut state.counters),
            embedding_batch_sizes: std::mem::take(&mut state.batch_sizes),
            files: std::mem::take(&mut state.files),
            model: crate::embedding::model_identity(),
            platform: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            available_parallelism: std::thread::available_parallelism().ok().map(usize::from),
            thread_environment: [
                "OMP_NUM_THREADS",
                "RAYON_NUM_THREADS",
                "TOKENIZERS_PARALLELISM",
            ]
            .into_iter()
            .filter_map(|name| std::env::var(name).ok().map(|value| (name, value)))
            .collect(),
        })
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        if let Some(state) = &self.0.0 {
            let mut state = state.lock().unwrap();
            let frame = state
                .stack
                .get_mut(&self.1)
                .unwrap()
                .pop()
                .expect("balanced profiling scopes");
            let elapsed = frame.start.elapsed().as_secs_f64();
            let exclusive = (elapsed - frame.children).max(0.0);
            *state.phases.entry(frame.name).or_default() += exclusive;
            let stage = match frame.name {
                "discovery" => Some("discovery"),
                "source_read" | "reuse_check" => Some("source"),
                "analysis" => Some("parsing"),
                "chunking_token_budget" | "document_texts" | "embedding_prepare" => Some("windows"),
                "vector_merge" => Some("merge"),
                "storage_save" | "invalidation" | "reconciliation" => Some("database"),
                _ => None,
            };
            if let Some(name) = stage {
                state.stages.entry(name).or_default().active_seconds += exclusive;
            }
            if let Some(file) = &mut state.current_file {
                *file.phases_seconds.entry(frame.name).or_default() += exclusive;
            }
            if let Some(parent) = state.stack.get_mut(&self.1).unwrap().last_mut() {
                parent.children += elapsed;
            }
        }
    }
}

impl Drop for StageScope {
    fn drop(&mut self) {
        if let (Some(state), Some(start)) = (&self.profile.0, self.start) {
            let mut state = state.lock().unwrap();
            let stage = state.stages.entry(self.name).or_default();
            let value = match self.activity {
                Activity::Active => &mut stage.active_seconds,
                Activity::Input => &mut stage.input_wait_seconds,
                Activity::Output => &mut stage.output_wait_seconds,
            };
            *value += start.elapsed().as_secs_f64();
        }
    }
}

impl Drop for FileScope {
    fn drop(&mut self) {
        if let Some(state) = &self.profile.0 {
            let mut state = state.lock().unwrap();
            let mut file = state.current_file.take().expect("balanced file profiling");
            file.wall_seconds = self.start.expect("file start").elapsed().as_secs_f64();
            state.files.push(file);
        }
        if let Some(parent) = &self.parent
            && let Some(report) = self.profile.finish(None)
        {
            parent.merge(report);
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/profiling.rs"]
mod tests;
