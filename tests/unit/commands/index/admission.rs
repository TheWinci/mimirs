use super::super::channel::Cancel;
use super::*;

#[test]
fn file_accounting_has_no_capacity_or_payload_limit_and_observes_cancellation() {
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let cancel = Cancel::default();
    let admission = Admission::new(&profile, &cancel);
    let mut permits: Vec<_> = (0..100)
        .map(|_| admission.acquire(33 * 1024 * 1024).unwrap())
        .collect();
    assert!(permits[0].grow(64 * 1024 * 1024));
    assert_eq!(
        profile.finish(None).unwrap().counters["index_queue_peak_files"],
        100
    );
    drop(permits);
    assert_eq!(admission.0.state.lock().unwrap().files, 0);
    assert_eq!(admission.0.state.lock().unwrap().bytes, 0);
    cancel.cancel();
    assert!(admission.acquire(1).is_none());
}
