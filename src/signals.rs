use tokio::signal::unix::{SignalKind, signal};

/// Wait for a signal that asks the process to stop, and return its name.
/// Catching one replaces the default action, so the caller must end the
/// process itself.
pub async fn wait_for_stop() -> anyhow::Result<&'static str> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let name = tokio::select! {
        _ = interrupt.recv() => "SIGINT",
        _ = terminate.recv() => "SIGTERM",
        _ = hangup.recv() => "SIGHUP",
    };
    Ok(name)
}
