/// Wait for a signal that asks the process to stop, and return its name.
/// Catching one replaces the default action, so the caller must end the
/// process itself.
#[cfg(unix)]
pub async fn wait_for_stop() -> anyhow::Result<&'static str> {
    use tokio::signal::unix::{SignalKind, signal};

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

/// Elsewhere, never return, so stop events keep their default action. Windows
/// console events can come here once someone can run mimirs on Windows.
#[cfg(not(unix))]
pub async fn wait_for_stop() -> anyhow::Result<&'static str> {
    std::future::pending().await
}
