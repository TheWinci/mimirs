use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn cancellation_wakes_full_producers_and_empty_consumers() {
    let cancel = Cancel::default();
    let profile = Profiler::enabled();
    let (full_tx, _full_rx) = bounded(1, "full", &profile, &cancel);
    let (_empty_tx, empty_rx) = bounded::<usize>(1, "empty", &profile, &cancel);
    full_tx.send(1, 100).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let done = done_tx.clone();
        scope.spawn(move || {
            assert_eq!(full_tx.send(2, 100), Err(2));
            done.send(()).unwrap();
        });
        scope.spawn(move || {
            assert_eq!(empty_rx.recv(), None);
            done_tx.send(()).unwrap();
        });
        cancel.cancel();
        for _ in 0..2 {
            done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
    });
    assert!(cancel.is_cancelled());
    let report = profile.finish(None).unwrap();
    assert_eq!(report.stages["full"].peak_queued_items, 1);
    assert_eq!(report.stages["full"].peak_queued_bytes, 100);
}

#[test]
fn channel_closure_keeps_order_and_drains_before_eof() {
    let cancel = Cancel::default();
    let (tx, rx) = bounded(2, "test", &Profiler::default(), &cancel);
    tx.send(1, 1).unwrap();
    tx.send(2, 1).unwrap();
    drop(tx);
    assert_eq!(rx.recv(), Some(1));
    assert_eq!(rx.recv(), Some(2));
    assert_eq!(rx.recv(), None);
}

#[test]
fn receiver_drop_and_late_channels_observe_cancellation() {
    let cancel = Cancel::default();
    let (tx, rx) = bounded(1, "test", &Profiler::default(), &cancel);
    drop(rx);
    assert_eq!(tx.send(1, 1), Err(1));
    cancel.cancel();
    let (tx, rx) = bounded(1, "late", &Profiler::default(), &cancel);
    assert_eq!(tx.send(2, 1), Err(2));
    assert_eq!(rx.recv(), None);
}
