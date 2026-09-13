use super::*;
use std::sync::{Arc, Mutex, OnceLock, mpsc};

#[derive(Clone)]
struct Pending {
    active: Active,
    indexed: Option<Event>,
    completion: Option<Vec<(String, String, String)>>,
}
pub struct Activity {
    root: PathBuf,
    target_claim: Option<String>,
    key: String,
    pending: Arc<Mutex<Pending>>,
    lease: Option<fs::File>,
    stop: Option<mpsc::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
    last_flush: u64,
    finished: bool,
    warning: Arc<Mutex<Option<String>>>,
}
fn flush(root: &Path, key: &str, pending: &Pending) -> Result<()> {
    update(root, |snapshot| {
        let Some(current) = snapshot.activities.get_mut(key) else {
            return;
        };
        if current.id != pending.active.id {
            return;
        }
        if current.sequence <= pending.active.sequence {
            *current = pending.active.clone();
        }
        current.heartbeat_at = now();
        if let Some(event) = &pending.indexed
            && snapshot
                .last_indexed
                .as_ref()
                .is_none_or(|old| old.id != event.id && old.at <= event.at)
        {
            snapshot.record(event.clone());
            snapshot.observe(
                "source",
                "incomplete",
                "file published; full operation may still be in progress",
                event.at,
                None,
            );
        }
    })
}
impl Activity {
    pub fn start(root: &Path, operation: &str, component: &str) -> Self {
        static PROCESS: OnceLock<String> = OnceLock::new();
        let root = root.canonicalize().unwrap_or_else(|_| root.into());
        let active = Active {
            id: uuid::Uuid::now_v7().to_string(),
            process_instance: PROCESS
                .get_or_init(|| uuid::Uuid::now_v7().to_string())
                .clone(),
            pid: std::process::id(),
            operation: operation.into(),
            component: component.into(),
            phase: operation.into(),
            file: None,
            target: None,
            started_at: now(),
            heartbeat_at: now(),
            sequence: 0,
        };
        let key = active.id.clone();
        let pending = Arc::new(Mutex::new(Pending {
            active,
            indexed: None,
            completion: None,
        }));
        let warning = Arc::new(Mutex::new(None));
        let mut value = Self {
            root,
            target_claim: None,
            key,
            pending,
            lease: None,
            stop: None,
            worker: None,
            last_flush: now(),
            finished: false,
            warning,
        };
        let setup = (|| -> Result<()> {
            let directory = directory(&value.root)?.join("status-owners");
            fs::create_dir_all(&directory)?;
            ensure!(
                fs::symlink_metadata(&directory)?.file_type().is_dir(),
                "status owners must be a local directory"
            );
            for entry in fs::read_dir(&directory)?.take(64) {
                let path = entry?.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.modified()?.elapsed().unwrap_or_default()
                    < Duration::from_millis(LIVE_AGE_MS)
                {
                    continue;
                }
                if !metadata.file_type().is_file() {
                    continue;
                }
                if let Ok(file) = fs::OpenOptions::new().read(true).write(true).open(&path)
                    && file.try_lock().is_ok()
                {
                    let _ = fs::remove_file(path);
                    let _ = file.unlock();
                }
            }
            let active = value.pending.lock().unwrap().active.clone();
            let lease = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(directory.join(&active.id))?;
            lease.try_lock()?;
            value.lease = Some(lease);
            update(&value.root, |s| {
                let stopped = s
                    .activities
                    .iter()
                    .filter(|(_, a)| super::view::lease(&value.root, a, now()).0 == "stopped")
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in stopped {
                    s.activities.remove(&id);
                }
                if s.activities.len() < 16 {
                    s.activities.insert(value.key.clone(), active);
                } else {
                    s.omitted_activities += 1;
                }
            })
        })();
        if let Err(error) = setup {
            warn(Err(error));
            return value;
        }
        let (send, receive) = mpsc::channel();
        value.stop = Some(send);
        let (root, key, pending, warning) = (
            value.root.clone(),
            value.key.clone(),
            value.pending.clone(),
            value.warning.clone(),
        );
        value.worker = Some(std::thread::spawn(move || {
            while receive
                .recv_timeout(Duration::from_millis(HEARTBEAT_MS))
                .is_err_and(|e| e == mpsc::RecvTimeoutError::Timeout)
            {
                if let Err(error) = flush(&root, &key, &pending.lock().unwrap().clone()) {
                    *warning.lock().unwrap() = Some(bounded(&error.to_string(), 384));
                }
            }
        }));
        value
    }
    pub fn completion(&mut self, observations: &[(&str, &str, &str)]) {
        self.pending.lock().unwrap().completion = Some(
            observations
                .iter()
                .map(|(component, status, basis)| {
                    (component.to_string(), status.to_string(), basis.to_string())
                })
                .collect(),
        );
    }
    pub fn target(&mut self, target: Option<Target>) {
        self.pending.lock().unwrap().active.target = target;
    }
    pub fn target_claim(&mut self, claim: Option<&str>) {
        self.target_claim = claim.map(|id| bounded(id, 64));
    }
    pub fn progress(&mut self, phase: &str, component: &str, file: Option<&str>) {
        {
            let mut state = self.pending.lock().unwrap();
            state.active.phase = bounded(phase, 64);
            state.active.component = component.into();
            state.active.file = file.filter(|p| *p != "-").map(|p| bounded(p, 256));
            state.active.sequence += 1;
        }
        self.flush(false);
    }
    pub fn published(&mut self, file: &str) {
        let event = self.event("indexed", "source", "success", None, None, None, Some(file));
        self.pending.lock().unwrap().indexed = Some(event);
        self.flush(false);
    }
    fn flush(&mut self, force: bool) {
        if self.lease.is_none() {
            return;
        }
        if force || now().saturating_sub(self.last_flush) >= 500 {
            warn(flush(
                &self.root,
                &self.key,
                &self.pending.lock().unwrap().clone(),
            ));
            self.last_flush = now();
        }
        if let Some(error) = self.warning.lock().unwrap().take() {
            warn(Err(anyhow::anyhow!(error)));
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn event(
        &self,
        operation: &str,
        component: &str,
        outcome: &str,
        reason: Option<&str>,
        claim: Option<&str>,
        preview: Option<&str>,
        file: Option<&str>,
    ) -> Event {
        let active = &self.pending.lock().unwrap().active;
        Event {
            id: uuid::Uuid::now_v7().to_string(),
            operation: operation.into(),
            component: component.into(),
            outcome: outcome.into(),
            target: active.target.clone(),
            started_at: active.started_at,
            at: now(),
            file: file
                .map(|p| bounded(p, 256))
                .or_else(|| active.file.clone()),
            claim: claim
                .map(|v| bounded(v, 64))
                .or_else(|| self.target_claim.clone()),
            preview: preview.map(|v| bounded(v, 160)),
            reason: reason.map(|v| bounded(v, 384)),
            next: (outcome != "success").then(|| next(component).into()),
        }
    }
    pub fn record(
        &mut self,
        operation: &str,
        component: &str,
        outcome: &str,
        reason: Option<&str>,
    ) {
        let event = self.event(operation, component, outcome, reason, None, None, None);
        warn(update(&self.root, |s| {
            s.record(event);
            s.observe(
                component,
                if outcome == "success" {
                    "observed"
                } else {
                    "unavailable"
                },
                "watch result at the recorded time; use explicit validation for freshness",
                now(),
                self.pending.lock().unwrap().active.target.clone(),
            );
        }));
    }
    pub fn failed(&mut self, operation: &str, reason: &str) {
        let component = self.pending.lock().unwrap().active.component.clone();
        self.record(operation, &component, "failure", Some(reason));
    }
    pub fn observe(&self, component: &str, status: &str, basis: &str) {
        warn(update(&self.root, |s| {
            s.observe(
                component,
                status,
                basis,
                now(),
                self.pending.lock().unwrap().active.target.clone(),
            )
        }));
    }
    pub fn finish(
        &mut self,
        outcome: &str,
        reason: Option<&str>,
        claim: Option<&str>,
        preview: Option<&str>,
    ) {
        if self.finished {
            return;
        }
        self.finished = true;
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.flush(true);
        let active = self.pending.lock().unwrap().active.clone();
        let event = self.event(
            &active.operation,
            &active.component,
            outcome,
            reason,
            claim,
            preview,
            None,
        );
        warn(update(&self.root, |s| {
            let current = s
                .activities
                .get(&self.key)
                .is_some_and(|a| a.id == active.id);
            if current {
                s.activities.remove(&self.key);
            }
            s.record(event.clone());
            if !current {
                return;
            }
            let successful = outcome == "success";
            if let Some(observations) = &self.pending.lock().unwrap().completion {
                for (component, status, basis) in observations {
                    s.observe(component, status, basis, event.at, active.target.clone());
                }
            } else {
                s.observe(
                    &active.component,
                    if successful {
                        "observed"
                    } else {
                        "unavailable"
                    },
                    "explicit operation result; no continuing freshness guarantee",
                    event.at,
                    active.target.clone(),
                );
            }
        }));
    }
    pub fn result<T>(&mut self, result: &Result<T>) {
        match result {
            Ok(_) => self.finish("success", None, None, None),
            Err(e) => self.finish("failure", Some(&e.to_string()), None, None),
        }
    }
}
impl Drop for Activity {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(
                "interrupted",
                Some("operation ended without a completion record"),
                None,
                None,
            );
        }
        if let Some(lease) = self.lease.take() {
            let _ = lease.unlock();
        }
        let id = self.pending.lock().unwrap().active.id.clone();
        let _ = fs::remove_file(self.root.join(".mimirs/status-owners").join(id));
    }
}
