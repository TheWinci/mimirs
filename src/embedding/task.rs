//! A file's ordered document vectors, produced without changing token inputs or
//! singleton model calls. Only the coordinator reports progress or touches storage.
use super::{DIMENSION, pool, ts_v2, validate};
use crate::profiling::Profiler;
use anyhow::{Result, ensure};
use std::sync::Arc;

pub struct SourceTask {
    inner: Task,
    pub retained_bytes: usize,
    profile: Option<Profiler>,
    counted: bool,
}

enum Task {
    Ready(Vec<Vec<f32>>),
    Pending {
        job: pool::Job,
        plans: Arc<Vec<Vec<usize>>>,
    },
}

#[derive(Clone)]
pub struct WindowPlan {
    pub inputs: Arc<Vec<String>>,
    pub documents: Arc<Vec<Vec<usize>>>,
}

impl WindowPlan {
    pub(crate) fn validate(&self, count: usize, path: &str) -> Result<()> {
        ensure!(self.documents.len() == count, "incomplete window mapping");
        let mut used = vec![false; self.inputs.len()];
        for plan in self.documents.iter() {
            ensure!(!plan.is_empty(), "document has no embedding windows");
            for &input in plan {
                ensure!(input < used.len(), "window mapping outside inputs");
                used[input] = true;
            }
        }
        ensure!(used.iter().all(|v| *v), "unmapped embedding inputs");
        let prefix = format!("File: {path}\n");
        ensure!(
            self.inputs.iter().all(|s| s.starts_with(&prefix)),
            "window source path mismatch"
        );
        Ok(())
    }
}

impl SourceTask {
    pub(crate) fn window_plan(&self) -> Result<WindowPlan> {
        match &self.inner {
            Task::Pending { job, plans } => Ok(WindowPlan {
                inputs: job.inputs(),
                documents: plans.clone(),
            }),
            Task::Ready(vectors) => {
                ensure!(vectors.is_empty(), "backend did not retain its window plan");
                Ok(WindowPlan {
                    inputs: Arc::default(),
                    documents: Arc::default(),
                })
            }
        }
    }

    pub(crate) fn completed(vectors: Vec<Vec<f32>>) -> Self {
        Self {
            profile: None,
            counted: false,
            retained_bytes: vectors.len() * DIMENSION * 4,
            inner: Task::Ready(vectors),
        }
    }

    pub(crate) fn pending(
        job: pool::Job,
        plans: Vec<Vec<usize>>,
        input_bytes: usize,
        inputs: usize,
    ) -> Self {
        let retained_bytes = input_bytes
            + inputs * DIMENSION * 4
            + plans
                .iter()
                .map(|p| p.len() * size_of::<usize>())
                .sum::<usize>();
        Self {
            profile: None,
            counted: false,
            inner: Task::Pending {
                job,
                plans: Arc::new(plans),
            },
            retained_bytes,
        }
    }

    pub(crate) fn with_profile(mut self, profile: Profiler) -> Self {
        self.profile = Some(profile);
        self
    }

    pub fn ready(&self) -> bool {
        match &self.inner {
            Task::Ready(_) => true,
            Task::Pending { job, .. } => job.ready(),
        }
    }

    pub fn finish(
        mut self,
        profile: &Profiler,
        mut progress: impl FnMut(usize, usize) -> Result<()>,
    ) -> Result<Vec<Vec<f32>>> {
        match &mut self.inner {
            Task::Ready(vectors) => Ok(std::mem::take(vectors)),
            Task::Pending { job, plans } => {
                let result = profile.measure("embedding_wait", || {
                    let _wait = profile.stage("windows", crate::profiling::Activity::Output);
                    job.wait()
                });
                for _ in 0..job.calls() {
                    profile.batch(1);
                }
                self.counted = true;
                let vectors = result?;
                validate(&vectors, vectors.len())?;
                let _merge = profile.scope("vector_merge");
                let total = plans.len();
                let mut output = Vec::with_capacity(total);
                for batch in plans.chunks(1024) {
                    for plan in batch {
                        output.push(ts_v2::merge(
                            &plan
                                .iter()
                                .map(|&i| vectors[i].as_slice())
                                .collect::<Vec<_>>(),
                        )?);
                    }
                    progress(output.len(), total)?;
                }
                profile.stage_items("merge", output.len());
                Ok(output)
            }
        }
    }
}

impl Drop for SourceTask {
    fn drop(&mut self) {
        if let Task::Pending { job, .. } = &mut self.inner {
            job.cancel();
            // A cancelled file may have an inference already in flight. Account
            // for it before its file profile is merged or the caller returns.
            if !self.counted {
                let _ = job.wait();
                if let Some(profile) = &self.profile {
                    for _ in 0..job.calls() {
                        profile.batch(1);
                    }
                }
            }
        }
    }
}
