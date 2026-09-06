use super::*;

#[test]
fn disabled_measurements_have_no_report_and_preserve_results() {
    let profile = Profiler::default();
    let _file = profile.file("a.rs");
    profile.count("files_read", 1);
    profile.batch(4);
    assert_eq!(profile.measure("work", || 42), 42);
    assert!(profile.finish(None).is_none());
}

#[test]
fn nested_phases_count_exclusive_time_and_keep_file_totals() {
    let profile = Profiler::enabled();
    {
        let _file = profile.file("a.py");
        let _outer = profile.scope("outer");
        profile.count("source_bytes", 17);
        profile.measure("inner", || profile.batch(3));
        let state = profile.0.as_ref().unwrap().borrow();
        assert_eq!(state.stack.len(), 1);
        assert_eq!(state.stack[0].name, "outer");
        assert_eq!(state.stack[0].children, state.phases["inner"]);
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
    assert_eq!(json["version"], 1);
    assert!(json["phases_seconds"].is_object());
}
