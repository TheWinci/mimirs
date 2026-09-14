//! One scoped visual timer. Processing retains all model and database ownership.
use super::{Progress, Screen};
use std::{
    io::{self, Write},
    path::Path,
    sync::{Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

struct State<'a> {
    output: &'a mut (dyn Write + Send),
    frame: Option<String>,
    lines: usize,
    elapsed: Duration,
    last_draw: Instant,
    stopped: bool,
    error: Option<(io::ErrorKind, String)>,
}
impl State<'_> {
    fn error(&self) -> io::Result<()> {
        match &self.error {
            Some((kind, message)) => Err(io::Error::new(*kind, message.clone())),
            None => Ok(()),
        }
    }
    fn remember(&mut self, result: io::Result<()>) -> io::Result<()> {
        if let Err(error) = &result {
            self.error.get_or_insert((error.kind(), error.to_string()));
        }
        result
    }
    fn clear_area(&mut self) -> io::Result<()> {
        if self.lines > 0 {
            write!(self.output, "\x1b[{}F\x1b[J", self.lines)?;
            self.lines = 0;
        }
        Ok(())
    }
    fn draw(&mut self, elapsed: Duration) -> io::Result<()> {
        self.error()?;
        let Some(frame) = &self.frame else {
            return Ok(());
        };
        self.elapsed = self.elapsed.max(elapsed);
        let mut block = String::new();
        for line in frame
            .lines()
            .filter(|line| !line.starts_with("elapsed_time:"))
        {
            block.push_str(line);
            block.push('\n');
        }
        block.push_str(&format!(
            "elapsed_time: {:.2} seconds\n",
            self.elapsed.as_secs_f64()
        ));
        let result = (|| {
            self.clear_area()?;
            self.output.write_all(b"\x1b[?7l")?;
            self.lines = block.lines().count();
            self.output.write_all(block.as_bytes())
        })();
        // Attempt restoration even after a partially written escape or frame.
        let restore = self.output.write_all(b"\x1b[?7h");
        let flushed = self.output.flush();
        self.last_draw = Instant::now();
        self.remember(result.and(restore).and(flushed))
    }
}
struct Live<'a> {
    state: Mutex<State<'a>>,
    wake: Condvar,
    elapsed: &'a (dyn Fn() -> Duration + Sync),
}
impl<'a> Live<'a> {
    fn lock(&self) -> MutexGuard<'_, State<'a>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn heartbeat(&self) {
        let mut state = self.lock();
        loop {
            if state.stopped || state.error.is_some() {
                break;
            }
            let remaining = Duration::from_secs(1).saturating_sub(state.last_draw.elapsed());
            if state.frame.is_some() && remaining.is_zero() {
                if state.draw((self.elapsed)()).is_err() {
                    break;
                }
                continue;
            }
            let wait = if state.frame.is_some() {
                remaining
            } else {
                Duration::from_secs(1)
            };
            state = self
                .wake
                .wait_timeout(state, wait)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
    fn stop(&self) {
        let mut state = self.lock();
        state.stopped = true;
        state.frame = None;
        self.wake.notify_all();
    }
    fn finish(&self) -> io::Result<()> {
        let mut state = self.lock();
        state.frame = None;
        let clear = state.clear_area();
        let wrap = state.output.write_all(b"\x1b[?7h");
        let flush = state.output.flush();
        state.remember(clear.and(wrap).and(flush))?;
        state.error()
    }
}
impl Screen for Live<'_> {
    fn render(&self, frame: &str) -> io::Result<()> {
        let mut state = self.lock();
        if state.stopped {
            return state.error();
        }
        state.frame = Some(frame.to_owned());
        let result = state.draw((self.elapsed)());
        self.wake.notify_all();
        result
    }
    fn clear(&self) -> io::Result<()> {
        self.finish()
    }
    fn diagnostic(&self, message: &str) -> io::Result<()> {
        self.finish()?;
        let mut state = self.lock();
        let result = writeln!(state.output, "{message}").and_then(|()| state.output.flush());
        state.remember(result)
    }
}
struct Stop<'a>(&'a Live<'a>);
impl Drop for Stop<'_> {
    fn drop(&mut self) {
        self.0.stop();
        let _ = self.0.finish();
    }
}

pub(crate) fn run<T>(
    root: &Path,
    output: &mut (dyn Write + Send),
    terminal: bool,
    elapsed: &(dyn Fn() -> Duration + Sync),
    operation: impl FnOnce(&mut Progress<'_>) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    if !terminal {
        return operation(&mut Progress::new(root, output, false, elapsed));
    }
    let live = Live {
        state: Mutex::new(State {
            output,
            frame: None,
            lines: 0,
            elapsed: Duration::ZERO,
            last_draw: Instant::now(),
            stopped: false,
            error: None,
        }),
        wake: Condvar::new(),
        elapsed,
    };
    std::thread::scope(|scope| {
        let _stop = Stop(&live);
        let timer = scope.spawn(|| live.heartbeat());
        let mut sink = io::sink();
        let mut progress = Progress::new(root, &mut sink, true, elapsed);
        progress.screen = Some(&live);
        let result = operation(&mut progress);
        drop(progress);
        live.stop();
        let joined = timer.join();
        let cleanup = live.finish();
        let value = result?;
        joined.map_err(|_| anyhow::anyhow!("terminal heartbeat failed"))?;
        cleanup?;
        Ok(value)
    })
}
