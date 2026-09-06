use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::{Context, anyhow, ensure};

use crate::profiling::Profiler;

/// Reuse model sessions, assign the next chunk to whichever worker is free, and
/// join every worker before returning. No work can outlive the current file.
pub(super) fn embed<W: Send>(
    workers: &mut [W],
    texts: &[String],
    profile: &Profiler,
    operation: impl Fn(&mut W, &str) -> anyhow::Result<Vec<f32>> + Sync,
) -> anyhow::Result<Vec<Vec<f32>>> {
    ensure!(!workers.is_empty(), "embedding needs at least one worker");
    let next = AtomicUsize::new(0);
    let calls = AtomicUsize::new(0);
    let cancelled = AtomicBool::new(false);
    let work = |worker: &mut W| {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut results = Vec::new();
            while !cancelled.load(Ordering::Relaxed) {
                let ordinal = next.fetch_add(1, Ordering::Relaxed);
                let Some(text) = texts.get(ordinal) else {
                    break;
                };
                calls.fetch_add(1, Ordering::Relaxed);
                results.push((
                    ordinal,
                    operation(worker, text)
                        .with_context(|| format!("embedding chunk {ordinal}"))?,
                ));
            }
            Ok(results)
        }))
        .unwrap_or_else(|_| Err(anyhow!("embedding worker panicked")));
        if result.is_err() {
            cancelled.store(true, Ordering::Relaxed);
        }
        result
    };
    let result = if workers.len() == 1 {
        work(&mut workers[0])
    } else {
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            let mut error = None;
            for worker in workers {
                match std::thread::Builder::new()
                    .name("mimirs-embedding".into())
                    .spawn_scoped(scope, || work(worker))
                {
                    Ok(handle) => handles.push(handle),
                    Err(cause) => {
                        cancelled.store(true, Ordering::Relaxed);
                        error = Some(anyhow!(cause).context("cannot start embedding worker"));
                        break;
                    }
                }
            }
            let mut results = Vec::new();
            // Join all handles even after an error, before the caller can touch
            // storage or report a failure. A partial result is never returned.
            for handle in handles {
                match handle
                    .join()
                    .unwrap_or_else(|_| Err(anyhow!("embedding worker panicked")))
                {
                    Ok(completed) => results.extend(completed),
                    Err(cause) => {
                        error.get_or_insert(cause);
                    }
                }
            }
            error.map_or(Ok(results), Err)
        })
    };
    for _ in 0..calls.load(Ordering::Relaxed) {
        profile.batch(1);
    }
    let mut ordered = result?;
    ensure!(
        ordered.len() == texts.len(),
        "embedding workers returned incomplete results"
    );
    ordered.sort_unstable_by_key(|(ordinal, _)| *ordinal);
    Ok(ordered.into_iter().map(|(_, vector)| vector).collect())
}

#[cfg(test)]
#[path = "../../tests/unit/embedding/pool.rs"]
mod tests;
