use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use tokenizers::Tokenizer;

use crate::chunk::{self, Chunk};
use crate::config::Config;
use crate::discover::{DiscoveredFile, Discovery, PathMatcher, discover};
use crate::embed::{self, Embedder, ModelInstance};
use crate::files::read::read_text;
use crate::keywords;
use crate::store::{FileRecord, Store};

/// Share of the file's path vector added to each of its window vectors, so
/// search finds code by the subsystem its path names (ranking plan D7).
const PATH_WEIGHT: f32 = 0.5;
/// Share of the chunk's path-and-name vector added to each of its windows.
const SYMBOL_WEIGHT: f32 = 0.25;

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

/// A file read and chunked, waiting for its vectors. Its embedding jobs are
/// its windows in chunk order, then its path terms, then one label per chunk
/// (see `labels`).
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

    fn job_count(&self) -> usize {
        self.window_count() + 1 + self.chunks.len()
    }
}

/// One text for a model to embed, a window or a label, tagged with its file
/// and its position among the file's jobs.
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
pub fn index_project(root: &Path) -> Result<Summary> {
    Indexer::load(root)?.catch_up()
}

/// A project's config and loaded model, kept between catch-ups so that only
/// the first one pays for loading. Config edits apply after a restart.
pub struct Indexer {
    root: PathBuf,
    config: Config,
    tokenizer: Tokenizer,
    embedder: Embedder,
    matcher: PathMatcher,
}

/// What the files named by watcher events need.
enum PathUpdate {
    /// Index these files if they changed, and remove these stored paths.
    Files {
        changed: Vec<DiscoveredFile>,
        gone: Vec<String>,
    },
    /// A folder or an ignore file changed; only a full walk can tell what that
    /// means.
    CatchUp,
}

impl Indexer {
    pub fn load(root: &Path) -> Result<Self> {
        let config = Config::load(&root.join(".mimirs/config.toml"))?;
        let model_files = embed::cached_files(&embed::cache_dir()?)
            .context("The embedding model is not downloaded; run `mimirs init` first")?;
        let tokenizer = embed::load_tokenizer(&model_files.tokenizer)?;
        let embedder = Embedder::load(&model_files, config.threads)?;
        let matcher = PathMatcher::new(root, &config)?;
        Ok(Self {
            root: root.to_path_buf(),
            config,
            tokenizer,
            embedder,
            matcher,
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Walk the project and index what changed since the last run.
    pub fn catch_up(&mut self) -> Result<Summary> {
        let mut store = Store::open(&self.root.join(".mimirs/index.db"))?;
        // The walk reads every ignore file afresh; the matcher must agree with it.
        self.matcher = PathMatcher::new(&self.root, &self.config)?;

        let discovery = discover(&self.root, &self.config)?;
        for error in &discovery.errors {
            eprintln!("{error}");
        }
        let known_files = store.file_states()?;
        let mut summary = Summary {
            too_large: discovery.skipped_too_large,
            ..Summary::default()
        };
        self.index_files(&discovery.files, &known_files, &mut store, &mut summary)?;

        if walk_found_everything(&discovery) {
            let found_paths: HashSet<String> = discovery
                .files
                .iter()
                .map(|file| stored_path(&file.path))
                .collect();
            summary.removed = store.remove_files_except(&found_paths)?;
        }
        store.record_finished_run()?;
        Ok(summary)
    }

    /// Bring just the given project paths up to date. Returns `None` when they
    /// need a full catch-up instead.
    pub fn update_paths(&mut self, relative_paths: &[PathBuf]) -> Result<Option<Summary>> {
        let mut store = Store::open(&self.root.join(".mimirs/index.db"))?;
        let known_files = store.file_states()?;
        let (changed, gone) =
            match classify_paths(&self.root, relative_paths, &known_files, &mut self.matcher)? {
                PathUpdate::Files { changed, gone } => (changed, gone),
                PathUpdate::CatchUp => return Ok(None),
            };

        let mut summary = Summary::default();
        self.index_files(&changed, &known_files, &mut store, &mut summary)?;
        store.remove_files(&gone)?;
        summary.removed = gone.len();
        Ok(Some(summary))
    }

    /// Index each of `files` that differs from its record.
    ///
    /// One thread reads and chunks files and queues their windows; each model
    /// instance takes the next window as soon as it is free; this thread writes
    /// a file once all of its vectors have arrived.
    fn index_files(
        &mut self,
        files: &[DiscoveredFile],
        known_files: &HashMap<String, (u64, i64)>,
        store: &mut Store,
        summary: &mut Summary,
    ) -> Result<()> {
        let root = self.root.as_path();
        let tokenizer = &self.tokenizer;
        // Unbounded for now, to measure how far reading runs ahead of embedding.
        let (job_sender, job_receiver) = mpsc::channel();
        // The model threads own the receiver, so once they all stop, queueing fails
        // and the preparing thread stops too.
        let job_receiver = Arc::new(Mutex::new(job_receiver));
        let (event_sender, event_receiver) = mpsc::channel();
        thread::scope(|scope| {
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
            for instance in self.embedder.instances() {
                let jobs = Arc::clone(&job_receiver);
                let events = event_sender.clone();
                scope.spawn(move || embed_windows(instance, jobs, events));
            }
            drop(job_receiver);
            drop(event_sender);
            write_files(event_receiver, store, files.len(), summary)
        })
    }
}

/// Decide what each path named by a watcher event needs, from what is on disk
/// now. Files are checked alone; a folder or an ignore file needs a full walk.
fn classify_paths(
    root: &Path,
    relative_paths: &[PathBuf],
    known_files: &HashMap<String, (u64, i64)>,
    matcher: &mut PathMatcher,
) -> Result<PathUpdate> {
    let mut changed = Vec::new();
    let mut gone = Vec::new();
    for relative_path in relative_paths {
        let is_ignore_file = relative_path
            .file_name()
            .is_some_and(|name| name == ".gitignore" || name == ".ignore");
        if is_ignore_file {
            return Ok(PathUpdate::CatchUp);
        }
        let path = stored_path(relative_path);
        match fs::symlink_metadata(root.join(relative_path)) {
            Ok(metadata) if metadata.is_dir() => return Ok(PathUpdate::CatchUp),
            Ok(metadata) => match matcher.file(relative_path, &metadata) {
                Some(file) => changed.push(file),
                // A stored file the rules now skip, such as one grown past the size limit.
                None if known_files.contains_key(&path) => gone.push(path),
                None => {}
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let folder_prefix = format!("{path}/");
                if known_files.contains_key(&path) {
                    gone.push(path);
                } else if known_files
                    .keys()
                    .any(|known| known.starts_with(&folder_prefix))
                {
                    // A removed folder; the walk finds everything that went with it.
                    return Ok(PathUpdate::CatchUp);
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(PathUpdate::Files { changed, gone })
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
        let path = stored_path(&file.path);
        let mut job_texts: Vec<String> = Vec::new();
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
                Ok(Some(text)) => match prepare(path, text, file, tokenizer) {
                    Ok((prepared, texts)) => {
                        job_texts = texts;
                        Event::Prepared {
                            file: file_number,
                            prepared,
                        }
                    }
                    Err(error) => Event::Failed(error),
                },
            }
        };

        let failed = matches!(event, Event::Failed(_));
        // The writer must know a file before any of its vectors arrive.
        if events.send(event).is_err() || failed {
            return;
        }
        for (window, text) in job_texts.into_iter().enumerate() {
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

/// Chunk a file's text and cut its chunks into windows, returning the prepared
/// file and the texts of its embedding jobs in order.
fn prepare(
    path: String,
    text: String,
    file: &DiscoveredFile,
    tokenizer: &Tokenizer,
) -> Result<(PreparedFile, Vec<String>)> {
    let chunks = chunk::chunk_file(&path, &text)?;
    let (window_counts, mut job_texts) = cut_windows(&text, &chunks, tokenizer)?;
    job_texts.extend(labels(&path, &chunks));
    let prepared = PreparedFile {
        path,
        size: file.size,
        modified: file.modified,
        text,
        chunks,
        window_counts,
    };
    Ok((prepared, job_texts))
}

/// The texts blended into a file's window vectors: first its path terms
/// (`src search hybrid ts`), then for each chunk its path and full name
/// (`src/queue.ts > Queue.drain`), or the path alone when it has no name.
fn labels(path: &str, chunks: &[Chunk]) -> Vec<String> {
    let mut labels = vec![keywords::terms(path).join(" ")];
    for index in 0..chunks.len() {
        let label = match chunk::full_name(chunks, index) {
            Some(name) => format!("{path} > {name}"),
            None => path.to_string(),
        };
        labels.push(label);
    }
    labels
}

/// normalize(window + PATH_WEIGHT · path + SYMBOL_WEIGHT · symbol): the
/// window's own meaning, pulled toward what its path and name say.
fn blend(window: &[f32], path: &[f32], symbol: &[f32]) -> Vec<f32> {
    let mut blended: Vec<f32> = window
        .iter()
        .zip(path)
        .zip(symbol)
        .map(|((window, path), symbol)| window + PATH_WEIGHT * path + SYMBOL_WEIGHT * symbol)
        .collect();
    let length = blended
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    for value in &mut blended {
        *value /= length;
    }
    blended
}

/// Cut each chunk's own text into windows, returning how many windows each
/// chunk has and every window's text in order.
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
                let job_count = prepared.job_count();
                pending.insert(
                    file,
                    PendingFile {
                        prepared,
                        vectors: vec![None; job_count],
                        missing: job_count,
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
        let window_vectors: Vec<Vec<f32>> = vectors
            .by_ref()
            .take(done.prepared.window_count())
            .collect();
        let path_vector = vectors.next().context("A file's path vector is missing")?;
        let symbol_vectors: Vec<Vec<f32>> = vectors.collect();
        let mut window_vectors = window_vectors.into_iter();
        let mut vectors_per_chunk: Vec<Vec<Vec<f32>>> = Vec::new();
        for (count, symbol_vector) in done.prepared.window_counts.iter().zip(&symbol_vectors) {
            let blended = window_vectors
                .by_ref()
                .take(*count)
                .map(|window| blend(&window, &path_vector, symbol_vector))
                .collect();
            vectors_per_chunk.push(blended);
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
fn stored_path(relative_path: &Path) -> String {
    relative_path.to_string_lossy().replace('\\', "/")
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

    /// Classify `paths` in a project holding `src/kept.rs`, `lib/inner.rs`, and an
    /// ignored `generated/out.rs`, with `src/kept.rs`, `src/gone.rs`, and
    /// `old/inner.rs` stored in the index.
    fn classify(paths: &[&str]) -> Result<PathUpdate> {
        let project = tempfile::tempdir()?;
        let root = project.path();
        for (path, text) in [
            ("src/kept.rs", "fn kept() {}"),
            ("lib/inner.rs", "fn inner() {}"),
            ("generated/out.rs", "fn out() {}"),
            (".gitignore", "generated/\n"),
        ] {
            fs::create_dir_all(root.join(path).parent().unwrap())?;
            fs::write(root.join(path), text)?;
        }
        let known_files: HashMap<String, (u64, i64)> =
            ["src/kept.rs", "src/gone.rs", "old/inner.rs"]
                .iter()
                .map(|path| (path.to_string(), (0, 0)))
                .collect();
        let mut matcher = PathMatcher::new(root, &Config::default())?;
        let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        classify_paths(root, &paths, &known_files, &mut matcher)
    }

    fn files(update: PathUpdate) -> (Vec<String>, Vec<String>) {
        match update {
            PathUpdate::Files { changed, gone } => (
                changed.iter().map(|file| stored_path(&file.path)).collect(),
                gone,
            ),
            PathUpdate::CatchUp => panic!("expected files, got a catch-up"),
        }
    }

    #[test]
    fn classifies_files_alone() -> Result<()> {
        let (changed, gone) = files(classify(&["src/kept.rs", "src/new.rs", "src/gone.rs"])?);
        // `src/new.rs` vanished before its turn and was never stored.
        assert_eq!(changed, ["src/kept.rs"]);
        assert_eq!(gone, ["src/gone.rs"]);

        // A rename names both sides: the old path is gone, the new one is a file.
        let (changed, gone) = files(classify(&["src/gone.rs", "lib/inner.rs"])?);
        assert_eq!(changed, ["lib/inner.rs"]);
        assert_eq!(gone, ["src/gone.rs"]);

        // Ignored through its parent folder.
        let (changed, gone) = files(classify(&["generated/out.rs"])?);
        assert!(changed.is_empty() && gone.is_empty());
        Ok(())
    }

    #[test]
    fn folders_and_ignore_files_need_a_catch_up() -> Result<()> {
        for paths in [
            &["lib"][..],
            &["old"],
            &[".gitignore"],
            &["src/kept.rs", "lib"],
        ] {
            assert!(matches!(classify(paths)?, PathUpdate::CatchUp), "{paths:?}");
        }
        Ok(())
    }

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
    fn labels_are_the_path_terms_then_each_chunk_s_path_and_name() -> Result<()> {
        let text = "class Queue {\n  drain() {}\n}\nconsole.log(1);\n";
        let chunks = chunk::chunk_file("src/queue.ts", text)?;
        let labels = labels("src/queue.ts", &chunks);
        assert_eq!(labels[0], "src queue ts");
        assert_eq!(labels.len(), chunks.len() + 1);
        assert!(labels.contains(&"src/queue.ts > Queue.drain".to_string()));
        assert!(labels.contains(&"src/queue.ts".to_string()));
        Ok(())
    }

    #[test]
    fn a_blend_is_unit_length_and_leans_toward_the_path() {
        let axis = |index: usize| {
            let mut vector = vec![0.0; 3];
            vector[index] = 1.0;
            vector
        };
        let blended = blend(&axis(0), &axis(1), &axis(2));
        let length: f32 = blended
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        assert!((length - 1.0).abs() < 1e-6);
        assert!(blended[0] > blended[1] && blended[1] > blended[2]);
        assert!((blended[1] / blended[0] - PATH_WEIGHT).abs() < 1e-6);
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
