use super::*;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Barrier, mpsc};

#[test]
fn workers_cross_file_boundaries_restore_order_and_reuse_threads() {
    let barrier = Arc::new(Barrier::new(3));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let threads = Arc::new(Mutex::new(HashSet::new()));
    let operation = {
        let (barrier, active, peak, threads) = (
            barrier.clone(),
            active.clone(),
            peak.clone(),
            threads.clone(),
        );
        move |_: &mut (), text: &str| {
            threads.lock().unwrap().insert(std::thread::current().id());
            let ordinal = text.parse::<usize>().unwrap();
            peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            if ordinal < 3 {
                barrier.wait();
            }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(vec![ordinal as f32])
        }
    };
    let pool = Pool::new(vec![(); 3], operation).unwrap();
    // Each job is a different one-window file. A per-file barrier would deadlock.
    let jobs = (0..3)
        .map(|i| pool.submit(vec![i.to_string()]))
        .collect::<Vec<_>>();
    for (i, mut job) in jobs.into_iter().enumerate() {
        assert_eq!(job.wait().unwrap(), vec![vec![i as f32]]);
    }
    let mut job = pool.submit((3..100).map(|i| i.to_string()).collect());
    assert_eq!(
        job.wait().unwrap(),
        (3..100).map(|i| vec![i as f32]).collect::<Vec<_>>()
    );
    assert_eq!(job.calls(), 97);
    assert_eq!(threads.lock().unwrap().len(), 3);
    assert_eq!(peak.load(Ordering::SeqCst), 3);
    drop(pool);
    assert_eq!(active.load(Ordering::SeqCst), 0);
}

#[test]
fn failures_and_panics_finish_inflight_calls_and_discard_partial_results() {
    for panic in [false, true] {
        let barrier = Arc::new(Barrier::new(2));
        let completed = Arc::new(AtomicUsize::new(0));
        let pool = Pool::new(vec![(); 2], {
            let completed = completed.clone();
            move |_, text| {
                barrier.wait();
                if text == "fail" {
                    assert!(!panic, "test model panic");
                    anyhow::bail!("test model failure");
                }
                completed.fetch_add(1, Ordering::SeqCst);
                Ok(vec![1.0])
            }
        })
        .unwrap();
        let mut job = pool.submit(vec!["fail".into(), "finish".into()]);
        let error = job.wait().unwrap_err();
        assert!(format!("{error:#}").contains(if panic {
            "worker panicked"
        } else {
            "test model failure"
        }));
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        assert_eq!(job.calls(), 2);
        assert!(job.ready());
    }
}

#[test]
fn cancelled_queued_files_never_reach_the_model() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let calls = Arc::new(AtomicUsize::new(0));
    let pool = Pool::new(vec![()], {
        let calls = calls.clone();
        move |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            started_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            Ok(vec![1.0])
        }
    })
    .unwrap();
    let mut first = pool.submit(vec!["first".into()]);
    started_rx.recv().unwrap();
    let second = pool.submit(vec!["cancelled".into(); 10]);
    drop(second);
    release_tx.send(()).unwrap();
    first.wait().unwrap();
    drop(pool);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn worker_metrics_survive_file_completion_and_account_for_cancelled_work() {
    let profile = Profiler::enabled();
    let (started, start) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Mutex::new(released);
    let pool = Pool::profiled(vec![()], profile.clone(), move |_, _| {
        started.send(()).unwrap();
        released.lock().unwrap().recv().unwrap();
        Ok(vec![0.0])
    })
    .unwrap();
    let mut first = pool.submit(vec!["active".into()]);
    start.recv().unwrap();
    let second = pool.submit(vec!["cancelled".into(); 7]);
    drop(second);
    release.send(()).unwrap();
    first.wait().unwrap();
    drop(pool);
    let report = profile.finish(None).unwrap();
    let stage = &report.stages["inference"];
    assert_eq!(stage.items, 1);
    assert_eq!(stage.peak_queued_items, 7);
    assert!(stage.active_seconds > 0.0);
}
