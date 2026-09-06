use super::*;
use std::sync::{Barrier, Mutex, mpsc};

#[test]
fn workers_run_concurrently_restore_order_and_reuse_sessions() {
    let mut workers = [0usize; 3];
    let texts = (0..20).map(|n| n.to_string()).collect::<Vec<_>>();
    let barrier = Barrier::new(3);
    let (tx, rx) = mpsc::channel();
    let rx = Mutex::new(rx);
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let profile = Profiler::enabled();
    let vectors = embed(&mut workers, &texts, &profile, |calls, text| {
        *calls += 1;
        let ordinal = text.parse::<usize>().unwrap();
        peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        if ordinal < 3 {
            barrier.wait();
        }
        if ordinal == 0 {
            rx.lock().unwrap().recv().unwrap();
        } else if ordinal == 1 {
            tx.send(()).unwrap();
        }
        active.fetch_sub(1, Ordering::SeqCst);
        Ok(vec![ordinal as f32])
    })
    .unwrap();
    assert_eq!(peak.load(Ordering::SeqCst), 3);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert!(workers.iter().all(|calls| *calls > 0));
    assert_eq!(vectors, (0..20).map(|n| vec![n as f32]).collect::<Vec<_>>());
    let report = profile.finish(None).unwrap();
    assert_eq!(report.counters["embedding_calls"], 20);
    assert_eq!(report.embedding_batch_sizes.len(), 1);
    assert_eq!(report.embedding_batch_sizes[&1], 20);
    embed(
        &mut workers,
        &texts[..1],
        &Profiler::default(),
        |calls, _| {
            *calls += 1;
            Ok(vec![0.0])
        },
    )
    .unwrap();
    assert_eq!(workers.iter().sum::<usize>(), 21);
}

#[test]
fn failures_and_panics_join_workers_and_discard_partial_results() {
    for panic in [false, true] {
        let mut workers = [0usize; 2];
        let barrier = Barrier::new(2);
        let profile = Profiler::enabled();
        let error = embed(
            &mut workers,
            &["fail".into(), "finish".into()],
            &profile,
            |calls, text| {
                *calls += 1;
                barrier.wait();
                if text == "fail" {
                    assert!(!panic, "test model panic");
                    anyhow::bail!("test model failure");
                }
                *calls += 1;
                Ok(vec![1.0])
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains(if panic {
            "worker panicked"
        } else {
            "test model failure"
        }));
        // Both sessions are accessible and the successful worker finished before
        // an error reached the caller. No detached work or partial vector list.
        assert_eq!(workers.iter().sum::<usize>(), 3);
        assert_eq!(
            profile.finish(Some(error.to_string())).unwrap().counters["embedding_calls"],
            2
        );
    }
}
