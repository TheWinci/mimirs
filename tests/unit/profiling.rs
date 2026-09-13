use super::*;

#[test]
fn disabled_measurements_have_no_report_and_preserve_results() {
    let profile = Profiler::default();
    let _file = profile.file("a.rs", crate::analysis::language::for_path("a.rs").identity);
    profile.count("files_read", 1);
    profile.batch(4);
    assert_eq!(profile.measure("work", || 42), 42);
    assert!(profile.finish(None).is_none());
    assert!(profile.queue_start().is_none());
}

#[test]
fn queue_distributions_merge_samples_before_computing_percentiles() {
    let parent = Profiler::enabled(crate::embedding::model_identity());
    for values in [vec![0.001, 0.003], vec![0.002, 0.1]] {
        let child = Profiler::enabled(crate::embedding::model_identity());
        for value in values {
            child
                .0
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .queues
                .entry("test")
                .or_default()
                .record(value);
        }
        parent.merge(child.finish(None).unwrap());
    }
    let report = parent.finish(None).unwrap();
    let queue = &report.queues["test"];
    assert_eq!(queue.items, 4);
    assert!((queue.total_seconds - 0.106).abs() < 1e-12);
    assert!((queue.mean_seconds - 0.0265).abs() < 1e-12);
    assert_eq!(queue.p50_seconds, 0.002);
    assert_eq!(queue.p95_seconds, 0.1);
    assert_eq!(queue.max_seconds, 0.1);
    let json = serde_json::to_value(&report).unwrap();
    assert!(json["queues"]["test"].get("samples").is_none());
}

#[test]
fn nested_phases_count_exclusive_time_and_keep_file_totals() {
    let profile = Profiler::enabled(crate::embedding::model_identity());
    {
        let _file = profile.file("a.py", crate::analysis::language::for_path("a.py").identity);
        let _outer = profile.scope("outer");
        profile.count("source_bytes", 17);
        profile.measure("inner", || profile.batch(3));
        let state = profile.0.as_ref().unwrap().lock().unwrap();
        assert_eq!(state.stack.len(), 1);
        assert_eq!(state.stack.values().next().unwrap()[0].name, "outer");
        assert_eq!(
            state.stack.values().next().unwrap()[0].children,
            state.phases["inner"]
        );
    }
    let report = profile.finish(Some("inference failed".into())).unwrap();
    assert!(!report.complete);
    assert_eq!(report.error.as_deref(), Some("inference failed"));
    assert!(report.phases_seconds.contains_key("outer"));
    assert!(report.phases_seconds.contains_key("inner"));
    let accounted = report.phases_seconds.values().sum::<f64>() + report.unassigned_seconds;
    assert!((accounted - report.wall_seconds).abs() < 1e-9);

    assert_eq!(report.counters["source_bytes"], 17);
    assert_eq!(report.counters["embedding_calls"], 1);
    assert_eq!(report.embedding_batch_sizes[&3], 1);
    assert_eq!(report.files[0].counters["source_bytes"], 17);
    assert!(report.files[0].language.starts_with("python/"));
    let json = serde_json::to_value(report).unwrap();
    assert_eq!(json["version"], 3);
    assert!(json["phases_seconds"].is_object());
}

#[test]
fn concurrent_scopes_keep_independent_stacks_and_wait_categories() {
    use std::sync::{Barrier, mpsc};
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let barrier = Arc::new(Barrier::new(2));
    std::thread::scope(|scope| {
        for name in ["first", "second"] {
            let p = profile.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                let _outer = p.scope(name);
                barrier.wait();
                p.measure("nested", || p.stage_items(name, 1));
            });
        }
    });
    let (send, receive) = mpsc::sync_channel(0);
    std::thread::scope(|scope| {
        let p = profile.clone();
        scope.spawn(move || {
            let _wait = p.stage("producer", Activity::Output);
            send.send(()).unwrap();
        });
        let _wait = profile.stage("consumer", Activity::Input);
        receive.recv().unwrap();
    });
    let report = profile.finish(None).unwrap();
    assert_eq!(report.stages["first"].items, 1);
    assert_eq!(report.stages["second"].items, 1);
    assert!(report.stages["producer"].output_wait_seconds > 0.0);
    assert_eq!(report.stages["producer"].input_wait_seconds, 0.0);
    assert!(report.stages["consumer"].input_wait_seconds > 0.0);
    assert_eq!(report.stages["consumer"].active_seconds, 0.0);
    assert!(report.phases_seconds.contains_key("first"));
    assert!(report.phases_seconds.contains_key("second"));
}
