use std::collections::{HashMap, HashSet};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use tokenizers::Tokenizer;

use crate::chunk::{self, Chunk};
use crate::config::Config;
use crate::discover::{DiscoveredFile, Discovery, discover};
use crate::embed::{self, Embedder, ModelInstance};
use crate::files::read::read_text;
use crate::store::{FileRecord, Store};

/// What one `index` run did.
#[derive(Default)]
pub struct Summary {
    pub files: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub chunks: usize,
    pub windows: usize,
    pub not_text: usize,
    pub too_large: usize,
    pub unreadable: usize,
}

/// A file read and chunked, waiting for its vectors.
struct PreparedFile {
    path: String,
    size: u64,
    modified: i64,
    text: String,
    chunks: Vec<Chunk>,
    /// How many windows each chunk was cut into, in chunk order.
    window_counts: Vec<usize>,
}

impl PreparedFile {
    fn window_count(&self) -> usize {
        self.window_counts.iter().sum()
    }
}

/// One window for a model to embed, tagged with its file and position.
struct WindowJob {
    file: usize,
    window: usize,
    text: String,
}

/// What the writer hears from the preparing thread and the model threads.
enum Event {
    Prepared {
        file: usize,
        prepared: PreparedFile,
    },
    Unchanged,
    NotText,
    Unreadable {
        path: PathBuf,
        error: String,
    },
    Embedded {
        file: usize,
        window: usize,
        vector: Vec<f32>,
    },
    Failed(anyhow::Error),
}

/// Bring the index in `root/.mimirs/index.db` up to date with the project's files.
///
/// One thread reads and chunks files and queues their windows; each model
/// instance takes the next window as soon as it is free; this thread writes a
/// file once all of its vectors have arrived.
pub fn index_project(root: &Path) -> Result<Summary> {
    let config = Config::load(&root.join(".mimirs/config.toml"))?;
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    let tokenizer = embed::load_tokenizer(&model_files.tokenizer)?;
    let mut embedder = Embedder::load(&model_files, config.threads)?;
    let mut store = Store::open(&root.join(".mimirs/index.db"))?;

    let discovery = discover(root, &config)?;
    for error in &discovery.errors {
        eprintln!("{error}");
    }
    let known_files = store.file_states()?;
    let mut summary = Summary {
        too_large: discovery.skipped_too_large,
        ..Summary::default()
    };

    // Unbounded for now, to measure how far reading runs ahead of embedding.
    let (job_sender, job_receiver) = mpsc::channel();
    // The model threads own the receiver, so once they all stop, queueing fails
    // and the preparing thread stops too.
    let job_receiver = Arc::new(Mutex::new(job_receiver));
    let (event_sender, event_receiver) = mpsc::channel();
    thread::scope(|scope| {
        let files = &discovery.files;
        let known_files = &known_files;
        let tokenizer = &tokenizer;
        let preparer_events = event_sender.clone();
        scope.spawn(move || {
            prepare_files(
                root,
                files,
                known_files,
                tokenizer,
                job_sender,
                preparer_events,
            )
        });
        for instance in embedder.instances() {
            let jobs = Arc::clone(&job_receiver);
            let events = event_sender.clone();
            scope.spawn(move || embed_windows(instance, jobs, events));
        }
        drop(job_receiver);
        drop(event_sender);
        write_files(event_receiver, &mut store, files.len(), &mut summary)
    })?;

    if walk_found_everything(&discovery) {
        let found_paths: HashSet<String> = discovery.files.iter().map(stored_path).collect();
        summary.removed = store.remove_files_except(&found_paths)?;
    }
    store.record_finished_run()?;
    Ok(summary)
}

/// Read and chunk each changed file, announce it to the writer, then queue its
/// windows. Stops when the writer or the models have stopped.
fn prepare_files(
    root: &Path,
    files: &[DiscoveredFile],
    known_files: &HashMap<String, (u64, i64)>,
    tokenizer: &Tokenizer,
    jobs: Sender<WindowJob>,
    events: Sender<Event>,
) {
    for (file_number, file) in files.iter().enumerate() {
        let path = stored_path(file);
        let mut window_texts: Vec<String> = Vec::new();
        let event = if is_unchanged(known_files.get(&path), file) {
            Event::Unchanged
        } else {
            match read_text(&root.join(&file.path)) {
                Ok(None) => Event::NotText,
                // A file can vanish or become unreadable after the walk; the rest
                // of the project still gets indexed.
                Err(error) => Event::Unreadable {
                    path: file.path.clone(),
                    error: error.to_string(),
                },
                Ok(Some(text)) => {
                    let chunks = chunk::line_chunks(&text);
                    match cut_windows(&text, &chunks, tokenizer) {
                        Ok((window_counts, texts)) => {
                            window_texts = texts;
                            Event::Prepared {
                                file: file_number,
                                prepared: PreparedFile {
                                    path,
                                    size: file.size,
                                    modified: file.modified,
                                    text,
                                    chunks,
                                    window_counts,
                                },
                            }
                        }
                        Err(error) => Event::Failed(error),
                    }
                }
            }
        };

        let failed = matches!(event, Event::Failed(_));
        // The writer must know a file before any of its vectors arrive.
        if events.send(event).is_err() || failed {
            return;
        }
        for (window, text) in window_texts.into_iter().enumerate() {
            let job = WindowJob {
                file: file_number,
                window,
                text,
            };
            if jobs.send(job).is_err() {
                return;
            }
        }
    }
}

/// Cut each chunk's own text into windows, returning how many windows each chunk
/// has and every window's text in order.
fn cut_windows(
    text: &str,
    chunks: &[Chunk],
    tokenizer: &Tokenizer,
) -> Result<(Vec<usize>, Vec<String>)> {
    let mut window_counts = Vec::new();
    let mut texts = Vec::new();
    for index in 0..chunks.len() {
        let own_text = chunk::own_text(text, chunks, index);
        let windows = embed::windows(&own_text, tokenizer)?;
        window_counts.push(windows.len());
        texts.extend(windows.into_iter().map(str::to_string));
    }
    Ok((window_counts, texts))
}

/// Embed queued windows with one model instance until the queue is closed and empty.
fn embed_windows(
    mut instance: ModelInstance,
    jobs: Arc<Mutex<Receiver<WindowJob>>>,
    events: Sender<Event>,
) {
    loop {
        let job = match jobs.lock() {
            Ok(receiver) => receiver.recv(),
            Err(_) => return,
        };
        let Ok(job) = job else {
            return;
        };
        let event = match instance.embed(&job.text) {
            Ok(vector) => Event::Embedded {
                file: job.file,
                window: job.window,
                vector,
            },
            Err(error) => Event::Failed(error),
        };
        let failed = matches!(event, Event::Failed(_));
        if events.send(event).is_err() || failed {
            return;
        }
    }
}

/// A prepared file and the vectors that have arrived for it so far.
struct PendingFile {
    prepared: PreparedFile,
    vectors: Vec<Option<Vec<f32>>>,
    missing: usize,
}

/// Write each file in its own transaction once all its vectors have arrived, and
/// show progress by files finished. Returns when every sender has stopped.
fn write_files(
    events: Receiver<Event>,
    store: &mut Store,
    total: usize,
    summary: &mut Summary,
) -> Result<()> {
    let show_progress = std::io::stderr().is_terminal();
    let terminal_width = terminal_size::terminal_size_of(std::io::stderr())
        .map_or(80, |(width, _)| usize::from(width.0));
    let mut pending: HashMap<usize, PendingFile> = HashMap::new();
    let mut finished = 0;

    for event in events {
        let completed = match event {
            Event::Prepared { file, prepared } => {
                let window_count = prepared.window_count();
                pending.insert(
                    file,
                    PendingFile {
                        prepared,
                        vectors: vec![None; window_count],
                        missing: window_count,
                    },
                );
                Some(file)
            }
            Event::Embedded {
                file,
                window,
                vector,
            } => {
                let pending_file = pending
                    .get_mut(&file)
                    .context("A vector arrived for an unknown file")?;
                pending_file.vectors[window] = Some(vector);
                pending_file.missing -= 1;
                Some(file)
            }
            Event::Unchanged => {
                summary.unchanged += 1;
                finished += 1;
                None
            }
            Event::NotText => {
                summary.not_text += 1;
                finished += 1;
                None
            }
            Event::Unreadable { path, error } => {
                clear_progress_line(show_progress);
                eprintln!("Could not read {}: {error}", path.display());
                summary.unreadable += 1;
                finished += 1;
                None
            }
            Event::Failed(error) => {
                clear_progress_line(show_progress);
                return Err(error);
            }
        };

        let Some(file) = completed else {
            continue;
        };
        let is_complete = pending.get(&file).is_some_and(|entry| entry.missing == 0);
        if !is_complete {
            continue;
        }
        let Some(done) = pending.remove(&file) else {
            continue;
        };
        let mut vectors = done.vectors.into_iter().flatten();
        let mut vectors_per_chunk: Vec<Vec<Vec<f32>>> = Vec::new();
        for &count in &done.prepared.window_counts {
            vectors_per_chunk.push(vectors.by_ref().take(count).collect());
        }
        let record = FileRecord {
            path: &done.prepared.path,
            size: done.prepared.size,
            modified: done.prepared.modified,
        };
        store.write_file(
            &record,
            &done.prepared.text,
            &done.prepared.chunks,
            &vectors_per_chunk,
        )?;
        summary.files += 1;
        summary.chunks += done.prepared.chunks.len();
        summary.windows += done.prepared.window_count();
        finished += 1;
        if show_progress {
            let line = progress_line(finished, total, &done.prepared.path, terminal_width);
            eprint!("\r\x1b[2K{line}");
            std::io::stderr().flush()?;
        }
    }
    clear_progress_line(show_progress);
    anyhow::ensure!(
        pending.is_empty(),
        "Indexing stopped before every file was embedded"
    );
    Ok(())
}

/// The path as stored in the index: relative to the root, with `/` separators.
fn stored_path(file: &DiscoveredFile) -> String {
    file.path.to_string_lossy().replace('\\', "/")
}

/// A file is unchanged when its size and modification time match its record.
/// An unknown modification time never counts as unchanged.
fn is_unchanged(known: Option<&(u64, i64)>, file: &DiscoveredFile) -> bool {
    file.modified != 0 && known == Some(&(file.size, file.modified))
}

/// Records may only be removed after a walk that saw the whole project. A walk
/// with errors or no files could otherwise delete the whole index.
fn walk_found_everything(discovery: &Discovery) -> bool {
    discovery.errors.is_empty() && !discovery.files.is_empty()
}

/// One progress line that fits `width` columns. A line that wraps cannot be
/// cleared in place, so long paths lose their start instead.
fn progress_line(done: usize, total: usize, path: &str, width: usize) -> String {
    let prefix = format!("{done}/{total} files · ");
    // Stay off the last column, where some terminals wrap early.
    let room = width.saturating_sub(prefix.chars().count() + 1);
    let path_length = path.chars().count();
    if path_length <= room {
        return format!("{prefix}{path}");
    }
    if room < 2 {
        return prefix.chars().take(width.saturating_sub(1)).collect();
    }
    let tail: String = path.chars().skip(path_length - (room - 1)).collect();
    format!("{prefix}…{tail}")
}

fn clear_progress_line(show_progress: bool) {
    if show_progress {
        eprint!("\r\x1b[2K");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn indexes_a_small_project() -> Result<()> {
        embed::download(&embed::cache_dir()?)?;
        let project = tempfile::tempdir()?;
        let root = project.path();
        fs::create_dir_all(root.join(".mimirs"))?;
        fs::write(
            root.join(".mimirs/config.toml"),
            Config::default().to_toml()?,
        )?;
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/token.rs"), "fn refresh_token() {}\n")?;
        fs::write(root.join("README.md"), "# Example\n\nA small project.\n")?;

        index_project(root)?;

        let database = Connection::open(root.join(".mimirs/index.db"))?;
        let count = |table: &str| -> anyhow::Result<i64> {
            Ok(
                database.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        };
        assert_eq!(count("files")?, 2);
        assert_eq!(count("chunks")?, 2);
        assert_eq!(count("window_vectors")?, count("windows")?);
        Ok(())
    }

    #[test]
    fn progress_lines_fit_the_terminal_width() {
        let path = "tests/fixtures_regress/fixtures/non_natural_2.xml";
        assert_eq!(
            progress_line(46, 3729, "src/a.rs", 80),
            "46/3729 files · src/a.rs"
        );
        let line = progress_line(46, 3729, path, 40);
        assert_eq!(line, "46/3729 files · …ures/non_natural_2.xml");
        assert!(line.chars().count() < 40);
        assert!(progress_line(46, 3729, path, 10).chars().count() < 10);
    }

    fn discovered(size: u64, modified: i64) -> DiscoveredFile {
        DiscoveredFile {
            path: "src/a.rs".into(),
            size,
            modified,
        }
    }

    #[test]
    fn unchanged_means_same_size_and_modification_time() {
        let known = (10, 500);
        assert!(is_unchanged(Some(&known), &discovered(10, 500)));
        assert!(!is_unchanged(Some(&known), &discovered(11, 500)));
        assert!(!is_unchanged(Some(&known), &discovered(10, 501)));
        assert!(!is_unchanged(None, &discovered(10, 500)));
        assert!(!is_unchanged(Some(&(10, 0)), &discovered(10, 0)));
    }

    #[test]
    fn removal_needs_a_complete_walk_that_found_files() {
        let walk = |files: Vec<DiscoveredFile>, errors: Vec<String>| Discovery {
            files,
            skipped_too_large: 0,
            errors,
        };
        assert!(walk_found_everything(&walk(vec![discovered(1, 1)], vec![])));
        assert!(!walk_found_everything(&walk(vec![], vec![])));
        assert!(!walk_found_everything(&walk(
            vec![discovered(1, 1)],
            vec!["permission denied".into()]
        )));
    }

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn a_second_run_only_does_work_for_changes() -> Result<()> {
        embed::download(&embed::cache_dir()?)?;
        let project = tempfile::tempdir()?;
        let root = project.path();
        fs::create_dir_all(root.join(".mimirs"))?;
        fs::write(
            root.join(".mimirs/config.toml"),
            Config::default().to_toml()?,
        )?;
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "fn a() {}\n")?;
        fs::write(root.join("src/b.rs"), "fn b() {}\n")?;
        fs::write(root.join("src/c.rs"), "fn c() {}\n")?;
        assert_eq!(index_project(root)?.files, 3);

        let second = index_project(root)?;
        assert_eq!((second.files, second.unchanged, second.removed), (0, 3, 0));

        fs::write(root.join("src/a.rs"), "fn a() { println!(\"edited\"); }\n")?;
        fs::remove_file(root.join("src/b.rs"))?;
        let third = index_project(root)?;
        assert_eq!((third.files, third.unchanged, third.removed), (1, 1, 1));

        let mut config = Config::default();
        config.exclude.push("src/c.rs".into());
        fs::write(root.join(".mimirs/config.toml"), config.to_toml()?)?;
        let fourth = index_project(root)?;
        assert_eq!((fourth.files, fourth.unchanged, fourth.removed), (0, 1, 1));
        Ok(())
    }
}
