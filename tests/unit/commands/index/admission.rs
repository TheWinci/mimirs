use super::super::channel::Cancel;
use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn oversized_files_run_alone_and_cancellation_wakes_admission() {
    let profile = Profiler::enabled();
    let cancel = Cancel::default();
    let admission = Admission::new(6, &profile, &cancel);
    let first = admission.acquire(PAYLOAD_TARGET + 1).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let permit = admission.acquire(1);
            tx.send(permit.is_some()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        drop(first);
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
    });
    let permit = admission.acquire(PAYLOAD_TARGET).unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| assert!(admission.acquire(1).is_none()));
        cancel.cancel();
    });
    drop(permit);
    assert_eq!(
        profile.finish(None).unwrap().counters["index_queue_peak_files"],
        1
    );
}
