use super::*;
use std::time::Duration;

#[tokio::test]
async fn producers_can_queue_without_a_consumer_and_cancel_discards_work() {
    let cancel = Cancel::default();
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let (tx, mut rx) = unbounded("test", &profile, &cancel);
    for n in 0..10_000 {
        tx.send(n, 100).unwrap();
    }
    let report = profile.finish(None).unwrap();
    assert_eq!(report.stages["test"].peak_queued_items, 10_000);
    assert_eq!(report.stages["test"].peak_queued_bytes, 1_000_000);
    cancel.cancel();
    assert_eq!(tx.send(10_000, 100), Err(10_000));
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn cancellation_wakes_an_empty_async_receiver() {
    let cancel = Cancel::default();
    let (_tx, mut rx) = unbounded::<usize>("empty", &Profiler::default(), &cancel);
    let receiver = tokio::spawn(async move { rx.recv().await });
    tokio::task::yield_now().await;
    cancel.cancel();
    assert_eq!(receiver.await.unwrap(), None);
}

#[test]
fn cancellation_wakes_an_empty_blocking_receiver() {
    let cancel = Cancel::default();
    let (_tx, mut rx) = unbounded::<usize>("empty", &Profiler::default(), &cancel);
    let (done, received) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        done.send(rx.blocking_recv()).unwrap();
    });
    cancel.cancel();
    assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), None);
    thread.join().unwrap();
}

#[tokio::test]
async fn channel_closure_keeps_order_and_drains_before_eof() {
    let cancel = Cancel::default();
    let (tx, mut rx) = unbounded("test", &Profiler::default(), &cancel);
    let other = tx.clone();
    tx.send(1, 1).unwrap();
    drop(tx);
    other.send(2, 1).unwrap();
    drop(other);
    assert_eq!(rx.recv().await, Some(1));
    assert_eq!(rx.recv().await, Some(2));
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn receiver_drop_and_late_channels_observe_cancellation() {
    let cancel = Cancel::default();
    let (tx, rx) = unbounded("test", &Profiler::default(), &cancel);
    drop(rx);
    assert_eq!(tx.send(1, 1), Err(1));
    cancel.cancel();
    let (tx, mut rx) = unbounded("late", &Profiler::default(), &cancel);
    assert_eq!(tx.send(2, 1), Err(2));
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn residence_counts_dequeued_items_and_excludes_cancelled_items() {
    let cancel = Cancel::default();
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let (tx, mut rx) = unbounded("test", &profile, &cancel);
    tx.send_at(1, 1, Some(Instant::now() - Duration::from_secs(2)))
        .unwrap();
    tx.send(2, 1).unwrap();
    assert_eq!(rx.recv().await, Some(1));
    cancel.cancel();
    assert_eq!(rx.recv().await, None);
    let report = profile.finish(None).unwrap();
    assert_eq!(report.queues["test"].items, 1);
    assert!(report.queues["test"].mean_seconds >= 2.0);
    assert_eq!(report.stages["test"].output_wait_seconds, 0.0);
    assert_eq!(report.stages["test"].input_wait_seconds, 0.0);
}
