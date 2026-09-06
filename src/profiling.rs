//! Optional local index measurements. Nested scopes contribute exclusive time.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Default)]
pub struct Profiler(Option<Rc<RefCell<State>>>);

struct State {
    start: Instant,
    stack: Vec<Frame>,
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

pub struct Scope(Profiler);
pub struct FileScope {
    profile: Profiler,
    start: Option<Instant>,
}

impl Profiler {
    pub fn enabled() -> Self {
        Self(Some(Rc::new(RefCell::new(State {
            start: Instant::now(),
            stack: Vec::new(),
            phases: BTreeMap::new(),
            counters: BTreeMap::new(),
            batch_sizes: BTreeMap::new(),
            files: Vec::new(),
            current_file: None,
        }))))
    }

    pub fn scope(&self, name: &'static str) -> Scope {
        if let Some(state) = &self.0 {
            state.borrow_mut().stack.push(Frame {
                name,
                start: Instant::now(),
                children: 0.0,
            });
        }
        Scope(self.clone())
    }

    pub fn measure<T>(&self, name: &'static str, operation: impl FnOnce() -> T) -> T {
        let _scope = self.scope(name);
        operation()
    }

    pub fn count(&self, name: &'static str, amount: usize) {
        if let Some(state) = &self.0 {
            let mut state = state.borrow_mut();
            *state.counters.entry(name).or_default() += amount as u64;
            if let Some(file) = &mut state.current_file {
                *file.counters.entry(name).or_default() += amount as u64;
            }
        }
    }

    pub fn batch(&self, size: usize) {
        self.count("embedding_calls", 1);
        self.count("embedding_documents", size);
        if let Some(state) = &self.0 {
            *state.borrow_mut().batch_sizes.entry(size).or_default() += 1;
        }
    }

    pub fn file(&self, path: &str) -> FileScope {
        let start = self.0.as_ref().map(|state| {
            let mut state = state.borrow_mut();
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
        }
    }

    /// Finish only after all scopes have dropped. Serialization is outside the timing.
    pub fn finish(&self, error: Option<String>) -> Option<Report> {
        let state = self.0.as_ref()?;
        let mut state = state.borrow_mut();
        assert!(state.stack.is_empty() && state.current_file.is_none());
        let wall_seconds = state.start.elapsed().as_secs_f64();
        let unassigned_seconds = (wall_seconds - state.phases.values().sum::<f64>()).max(0.0);
        Some(Report {
            version: 1,
            complete: error.is_none(),
            error,
            wall_seconds,
            phases_seconds: std::mem::take(&mut state.phases),
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
            let mut state = state.borrow_mut();
            let frame = state.stack.pop().expect("balanced profiling scopes");
            let elapsed = frame.start.elapsed().as_secs_f64();
            let exclusive = (elapsed - frame.children).max(0.0);
            *state.phases.entry(frame.name).or_default() += exclusive;
            if let Some(file) = &mut state.current_file {
                *file.phases_seconds.entry(frame.name).or_default() += exclusive;
            }
            if let Some(parent) = state.stack.last_mut() {
                parent.children += elapsed;
            }
        }
    }
}

impl Drop for FileScope {
    fn drop(&mut self) {
        if let Some(state) = &self.profile.0 {
            let mut state = state.borrow_mut();
            let mut file = state.current_file.take().expect("balanced file profiling");
            file.wall_seconds = self.start.expect("file start").elapsed().as_secs_f64();
            state.files.push(file);
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/profiling.rs"]
mod tests;
