use super::*;
use crate::context::test_support::{self as support, Fixture};
use crate::embedding::Backend;
use crate::storage;
use std::fs;
use std::{cell::Cell, rc::Rc};

fn options(f: &Fixture) -> Options {
    f.index(&[]);
    Options {
        root: f.root.canonicalize().unwrap(),
        once: true,
        repository: Some(f.repository.0.clone()),
        state: Some(f.state.clone()),
        ..Default::default()
    }
}
fn step(engine: &mut Engine, o: &Options, force: bool) -> Cycle {
    engine
        .cycle(o, force, support::fixed, analysis::extract)
        .unwrap()
}
fn paths(o: &Options) -> Vec<String> {
    indexed_paths(&storage::open_read_only(&o.root.join(".mimirs/index.db")).unwrap()).unwrap()
}
fn assert_absent(o: &Options, path: &str) {
    let db = storage::open_read_only(&o.root.join(".mimirs/index.db")).unwrap();
    assert!(storage::analysis::load(&db, path).unwrap().is_none());
    for table in [
        "source_snapshots",
        "entities",
        "source_chunks",
        "analysis_records",
        "retrieval_documents",
        "retrieval_processing",
    ] {
        let orphan:i64=db.query_row(&format!("SELECT count(*) FROM {table} t LEFT JOIN files f ON f.id=t.file_id WHERE f.id IS NULL"),[],|r|r.get(0)).unwrap();
        assert_eq!(orphan, 0, "{table}");
    }
    let orphan:i64=db.query_row("SELECT count(*) FROM document_embeddings v LEFT JOIN retrieval_documents d ON d.id=v.document_id WHERE d.id IS NULL",[],|r|r.get(0)).unwrap();
    assert_eq!(orphan, 0);
}
struct Counted {
    prepare: Rc<Cell<usize>>,
    tokenizer_calls: Rc<Cell<usize>>,
    embed: Rc<Cell<usize>>,
    fail: Rc<Cell<bool>>,
}
impl Backend for Counted {
    fn prepare(&mut self) -> Result<()> {
        self.prepare.set(self.prepare.get() + 1);
        Ok(())
    }
    fn tokenizer(&mut self) -> Result<tokenizers::Tokenizer> {
        self.tokenizer_calls.set(self.tokenizer_calls.get() + 1);
        Ok(crate::test_support::tokenizer(512))
    }
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed.set(self.embed.get() + texts.len());
        ensure!(!self.fail.get(), "injected inference failure");
        Ok(vec![support::vector(); texts.len()])
    }
}
#[test]
fn idle_reuses_model_and_publishes_nothing() {
    let mut f = Fixture::new();
    let o = options(&f);
    f.learn("preserve source bytes", None, &["reader.rs"]);
    let mut engine = Engine::default();
    let prepare = Rc::new(Cell::new(0));
    let tokenizer_calls = Rc::new(Cell::new(0));
    let embed = Rc::new(Cell::new(0));
    let fail = Rc::new(Cell::new(false));
    let first = engine
        .cycle(
            &o,
            true,
            || {
                Ok(Embedder::new(Counted {
                    prepare: prepare.clone(),
                    tokenizer_calls: tokenizer_calls.clone(),
                    embed: embed.clone(),
                    fail,
                }))
            },
            analysis::extract,
        )
        .unwrap();
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(first.indexed, 2);
    assert!(first.knowledge_support_reads > 0);
    assert!(first.knowledge_journal_replays > 0);
    let before = embed.get();
    let idle = engine
        .cycle(&o, false, support::unused, |_| panic!("idle analysis"))
        .unwrap();
    assert_eq!(idle.selected_source_reads, 0);
    assert_eq!(idle.knowledge_support_reads, 0);
    assert_eq!(idle.knowledge_journal_replays, 0);
    assert_eq!(idle.analyzed, 0);
    assert_eq!(idle.embedded_documents, 0);
    assert!(
        !idle.graph_published
            && !idle.knowledge_assessed
            && !idle.knowledge_published
            && !idle.state_published
    );
    fs::write(o.root.join("reader.rs"), "fn read_bytes() { fresh(); }\n").unwrap();
    let changed = engine
        .cycle(&o, false, support::unused, analysis::extract)
        .unwrap();
    assert_eq!(changed.indexed, 1);
    assert!(embed.get() > before);
    assert_eq!(prepare.get(), 1);
    assert_eq!(tokenizer_calls.get(), 1);
    let forced = engine
        .cycle(&o, true, support::unused, |_| {
            panic!("unchanged forced analysis")
        })
        .unwrap();
    assert!(!forced.graph_rebuilt && !forced.graph_published);
    assert!(!forced.knowledge_assessed && !forced.knowledge_published);
    assert!(forced.knowledge_support_reads > 0);
}
#[test]
fn failures_retire_vectors_facts_and_edges_then_recover() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    fs::write(
        o.root.join("entry.ts"),
        "import { run } from './worker';\nrun();\n",
    )
    .unwrap();
    fs::write(o.root.join("worker.ts"), "export function run() {}\n").unwrap();
    let fail = Rc::new(Cell::new(false));
    let r = engine
        .cycle(
            &o,
            true,
            || {
                Ok(Embedder::new(Counted {
                    prepare: Rc::new(Cell::new(0)),
                    tokenizer_calls: Rc::new(Cell::new(0)),
                    embed: Rc::new(Cell::new(0)),
                    fail: fail.clone(),
                }))
            },
            analysis::extract,
        )
        .unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(!graph::read(&o.root).unwrap().calls.is_empty());
    fail.set(true);
    fs::write(
        o.root.join("worker.ts"),
        "export function run() { broken_model(); }\n",
    )
    .unwrap();
    fs::write(
        o.root.join("reader.rs"),
        "fn read_bytes() { also_changed(); }\n",
    )
    .unwrap();
    let r = step(&mut engine, &o, false);
    assert!(!r.errors.is_empty());
    assert_absent(&o, "worker.ts");
    assert_absent(&o, "reader.rs");
    assert!(graph::read(&o.root).is_err());
    assert!(!paths(&o).contains(&"worker.ts".into()));
    fail.set(false);
    let r = step(&mut engine, &o, false);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(graph::read(&o.root).is_ok());
    fs::write(o.root.join("worker.ts"), "export function run( {\n").unwrap();
    let r = step(&mut engine, &o, false);
    assert!(!r.errors.is_empty());
    assert_absent(&o, "worker.ts");
    fs::write(o.root.join("worker.ts"), "export function run() {}\n").unwrap();
    assert!(step(&mut engine, &o, false).errors.is_empty());
    fs::rename(o.root.join("worker.ts"), o.root.join("renamed.ts")).unwrap();
    assert!(graph::read(&o.root).is_err());
    assert!(step(&mut engine, &o, false).errors.is_empty());
    assert_absent(&o, "worker.ts");
    assert!(graph::read(&o.root).unwrap().calls.is_empty());
    assert!(paths(&o).contains(&"renamed.ts".into()));
}
#[test]
fn forced_reconciliation_and_restart_recover_missed_metadata_changes() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    let path = o.root.join("reader.rs");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let old = fs::read_to_string(&path).unwrap();
    let new = old.replace("preserve_original", "different_routine");
    assert_eq!(old.len(), new.len());
    fs::write(&path, new).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let idle = step(&mut engine, &o, false);
    assert_eq!(idle.indexed, 0);
    assert!(graph::read(&o.root).is_err());
    let forced = step(&mut engine, &o, true);
    assert_eq!(forced.indexed, 1);
    assert!(forced.errors.is_empty());
    fs::remove_file(o.root.join("retry.rs")).unwrap();
    let restart = step(&mut Engine::default(), &o, true);
    assert!(restart.errors.is_empty());
    assert_absent(&o, "retry.rs");
}
#[test]
fn config_failure_and_selection_changes_remove_obsolete_rows() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    fs::write(o.root.join(".mimirs/config.toml"), "broken = [").unwrap();
    assert!(graph::read(&o.root).is_err());
    assert!(!step(&mut engine, &o, false).errors.is_empty());
    assert!(paths(&o).is_empty());
    assert_absent(&o, "reader.rs");
    fs::write(
        o.root.join(".mimirs/config.toml"),
        "include = ['**/*']\nexclude = ['**/.mimirs/**','**/.git/**']\n",
    )
    .unwrap();
    fs::write(o.root.join(".gitignore"), ".mimirs/\nreader.rs\n").unwrap();
    assert!(step(&mut engine, &o, false).errors.is_empty());
    assert_absent(&o, "reader.rs");
    fs::write(
        o.root.join(".mimirs/config.toml"),
        "include = ['reader.rs']\n",
    )
    .unwrap();
    assert!(step(&mut engine, &o, false).errors.is_empty());
    assert_eq!(paths(&o), vec!["reader.rs"]);
}
#[test]
fn writer_lock_and_manual_index_mutation_cannot_publish_stale_graph() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    let lock = crate::storage::writer::acquire(&o.root).unwrap();
    fs::remove_file(o.root.join("retry.rs")).unwrap();
    assert!(
        engine
            .cycle(&o, false, support::unused, analysis::extract)
            .is_err()
    );
    assert!(paths(&o).contains(&"retry.rs".into()));
    drop(lock);
    assert!(step(&mut engine, &o, false).errors.is_empty());
    let db = storage::open(&o.root.join(".mimirs/index.db"))
        .unwrap()
        .connection;
    db.execute("DELETE FROM document_embeddings", []).unwrap();
    drop(db);
    assert!(graph::read(&o.root).is_err());
    assert_eq!(step(&mut engine, &o, false).indexed, 1);
    assert!(graph::read(&o.root).is_ok());
}
#[test]
fn knowledge_cache_invalidates_on_support_journal_and_branch_without_events() {
    let mut f = Fixture::new();
    let o = options(&f);
    let id = f.learn("read preserves bytes", None, &["reader.rs"]);
    let journal = f.journal();
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).knowledge_assessed);
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "cache");
    fs::write(o.root.join("reader.rs"), [0xff, 0xfe]).unwrap();
    let live = knowledge::read(&o.knowledge());
    assert_eq!(live["origin"], "live");
    assert_eq!(
        live["assessment"]["items"][0]["evidence"][0]["comparison"],
        "Unavailable"
    );
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    assert_eq!(f.journal(), journal);
    // A pulled/locally appended event uses the same immutable journal read path.
    f.learn("second finding", None, &["retry.rs"]);
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "live");
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    support::git(&o.root, &["checkout", "-b", "feature"]);
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "live");
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "cache");
    assert!(
        knowledge::read(&o.knowledge())["assessment"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == json!(id))
    );
}
#[test]
fn edits_during_inference_invalidate_the_published_snapshot() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    fs::write(o.root.join("reader.rs"), "fn changed() {}\n").unwrap();
    let report = engine
        .cycle(&o, false, support::unused, |source| {
            fs::write(o.root.join("retry.rs"), "fn concurrent_edit() {}\n")?;
            analysis::extract(source)
        })
        .unwrap();
    assert!(!report.errors.is_empty());
    assert_absent(&o, "retry.rs");
    assert!(graph::read(&o.root).is_err());
    assert!(step(&mut engine, &o, false).errors.is_empty());
}

#[test]
fn graph_tracks_go_module_asset_existence_exports_and_ignore_rules() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    fs::create_dir(o.root.join("worker")).unwrap();
    for (path, text) in [
        ("go.mod", "module \"example.com/project\"\n"),
        (
            "main.go",
            "package main\nimport \"example.com/project/worker\"\nfunc main() { worker.Run() }\n",
        ),
        ("worker/work.go", "package worker\nfunc Run() {}\n"),
        ("index.html", "<img src=\"image.png\">\n"),
        ("entry.ts", "import { run } from './worker';\nrun();\n"),
        ("worker.ts", "export function run() {}\n"),
    ] {
        fs::write(o.root.join(path), text).unwrap();
    }
    fs::write(o.root.join("image.png"), [255, 0, 128]).unwrap();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    let graph = graph::read(&o.root).unwrap();
    assert!(graph.calls.iter().any(|e| e.to_path == "worker/work.go"));
    assert!(graph.imports.iter().any(|e| e.to_path == "image.png"));
    fs::write(o.root.join("go.mod"), "module \"example.com/other\"\n").unwrap();
    assert!(graph::read(&o.root).is_err());
    let changed = step(&mut engine, &o, false);
    assert!(changed.errors.is_empty(), "{:?}", changed.errors);
    assert!(
        !graph::read(&o.root)
            .unwrap()
            .calls
            .iter()
            .any(|e| e.to_path == "worker/work.go")
    );
    fs::remove_file(o.root.join("image.png")).unwrap();
    assert!(graph::read(&o.root).is_err());
    let removed = step(&mut engine, &o, false);
    assert_eq!(removed.analyzed, 0);
    assert!(removed.graph_published);
    assert!(
        !graph::read(&o.root)
            .unwrap()
            .imports
            .iter()
            .any(|e| e.to_path == "image.png")
    );
    fs::write(o.root.join("image.png"), [255, 0]).unwrap();
    assert!(step(&mut engine, &o, false).errors.is_empty());
    fs::write(o.root.join(".gitignore"), ".mimirs/\nimage.png\n").unwrap();
    assert!(graph::read(&o.root).is_err());
    assert!(step(&mut engine, &o, false).errors.is_empty());
    assert!(
        !graph::read(&o.root)
            .unwrap()
            .imports
            .iter()
            .any(|e| e.to_path == "image.png")
    );
    fs::write(o.root.join("worker.ts"), "export function renamed() {}\n").unwrap();
    assert!(graph::read(&o.root).is_err());
    assert_eq!(step(&mut engine, &o, false).indexed, 1);
    assert!(
        !graph::read(&o.root)
            .unwrap()
            .calls
            .iter()
            .any(|e| e.to_path == "worker.ts")
    );
}
#[test]
fn discovery_failure_and_prepare_failure_leave_no_obsolete_evidence() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    fs::write(o.root.join(".ignore"), "[z-a]\n").unwrap();
    assert!(!step(&mut engine, &o, false).errors.is_empty());
    assert!(paths(&o).is_empty());
    assert_absent(&o, "reader.rs");
    fs::remove_file(o.root.join(".ignore")).unwrap();
    assert!(step(&mut engine, &o, false).errors.is_empty());
    fs::write(o.root.join("reader.rs"), "fn changed_one() {}\n").unwrap();
    fs::write(o.root.join("retry.rs"), "fn changed_two() {}\n").unwrap();
    let r = Engine::default()
        .cycle(
            &o,
            true,
            || anyhow::bail!("injected prepare failure"),
            analysis::extract,
        )
        .unwrap();
    assert!(!r.errors.is_empty());
    assert!(paths(&o).is_empty());
    assert_absent(&o, "reader.rs");
    assert_absent(&o, "retry.rs");
    assert!(graph::read(&o.root).is_err());
    assert!(step(&mut engine, &o, false).errors.is_empty());
}

#[test]
fn pulled_events_and_support_outside_index_selection_refresh_cache() {
    let mut f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    fs::write(o.root.join("support.dat"), "actual support\n").unwrap();
    support::commit(&o.root);
    assert!(step(&mut engine, &o, true).errors.is_empty());
    let registry = crate::knowledge::registry::LocalDirectoryRegistry::new(
        &f._temp.path().join("registry"),
        &f.repository,
    );
    let mut remote =
        crate::knowledge::Store::open(&f._temp.path().join("remote"), &f.repository).unwrap();
    remote
        .learn(
            &f.checkout(),
            &support::actor(),
            crate::knowledge::model::KnowledgeKind::Discovery,
            "support lives outside selected source",
            None,
            &["support.dat".into()],
        )
        .unwrap();
    remote.publish(&registry).unwrap();
    assert!(f.store.pull(&registry).unwrap() > 0);
    let journal = f.journal();
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "live");
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    assert!(!paths(&o).contains(&"support.dat".into()));
    fs::write(o.root.join("support.dat"), "changed support\n").unwrap();
    let live = knowledge::read(&o.knowledge());
    assert_eq!(live["origin"], "live");
    assert_eq!(
        live["assessment"]["items"][0]["evidence"][0]["comparison"],
        "Modified"
    );
    let changed = step(&mut engine, &o, false);
    assert_eq!(changed.analyzed, 0);
    assert!(changed.knowledge_assessed);
    assert_eq!(f.journal(), journal);
    assert!(!step(&mut Engine::default(), &o, true).knowledge_assessed);
}

#[test]
fn deepening_history_invalidates_same_head_knowledge_cache() {
    let mut f = Fixture::new();
    let o = options(&f);
    f.learn("bytes stay intact", None, &["reader.rs"]);
    fs::write(o.root.join("unrelated.txt"), "another commit\n").unwrap();
    support::commit(&o.root);
    let head = support::git(&o.root, &["rev-parse", "HEAD"]);
    let shallow = o.root.join(".git/shallow");
    fs::write(&shallow, format!("{head}\n")).unwrap();
    assert!(knowledge::refresh(&o.knowledge()).unwrap().0);
    assert_eq!(
        knowledge::read(&o.knowledge())["assessment"]["items"][0]["status"],
        "NeedsRevalidation"
    );
    fs::remove_file(shallow).unwrap();
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "live");
    assert_eq!(
        knowledge::read(&o.knowledge())["assessment"]["items"][0]["status"],
        "Verified"
    );
    assert!(knowledge::refresh(&o.knowledge()).unwrap().0);
}

#[test]
fn forced_knowledge_refresh_catches_same_metadata_support_edit() {
    let mut f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    fs::write(o.root.join("support.dat"), "original\n").unwrap();
    support::commit(&o.root);
    f.learn("support is original", None, &["support.dat"]);
    // Keep the dirty bit set before both observations so it cannot reveal the edit.
    fs::write(o.root.join("unrelated.dat"), "dirty\n").unwrap();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    let journal = f.journal();
    let path = o.root.join("support.dat");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "modified\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let idle = step(&mut engine, &o, false);
    assert_eq!(idle.selected_source_reads, 0);
    assert_eq!(idle.knowledge_support_reads, 0);
    assert_eq!(idle.knowledge_journal_replays, 0);
    assert!(!idle.knowledge_assessed && !idle.knowledge_published);
    let status = knowledge::read(&o.knowledge());
    assert_eq!(status["origin"], "live");
    assert_eq!(
        status["assessment"]["items"][0]["status"],
        "NeedsRevalidation"
    );
    let forced = step(&mut engine, &o, true);
    assert!(forced.knowledge_support_reads > 0 && forced.knowledge_journal_replays > 0);
    assert!(forced.knowledge_assessed && forced.knowledge_published);
    assert!(!forced.graph_rebuilt);
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "cache");
    assert_eq!(f.journal(), journal);
}

#[test]
fn settings_and_current_review_support_drive_metadata_observation() {
    let mut f = Fixture::new();
    let mut o = options(&f);
    o.repository = None;
    let mut engine = Engine::default();
    assert!(step(&mut engine, &o, true).errors.is_empty());
    assert_eq!(
        knowledge::read(&o.knowledge())["assessment"]["status"],
        "not_configured"
    );
    crate::knowledge::settings::setup(&o.root, Some(&f.repository.0), None, None).unwrap();
    let id = f.learn("read and retry behavior", None, &["reader.rs"]);
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    let claims = crate::knowledge::projection::reduce(&f.events()).unwrap();
    let checkout = f.checkout();
    let replaces = crate::knowledge::reviews::active(&checkout, &claims[&id])
        .unwrap()
        .ids();
    f.store
        .review(
            &checkout,
            &support::actor(),
            crate::knowledge::ReviewRequest {
                knowledge: id,
                replaces,
                paths: &["retry.rs".into()],
                promote: false,
            },
        )
        .unwrap();
    let changed = step(&mut engine, &o, false);
    assert!(changed.knowledge_assessed);
    // Two exact observations of one currently applicable path. The retired
    // reader.rs attachment does not add another pair of support reads.
    assert_eq!(changed.knowledge_support_reads, 2);
    let cached = knowledge::read(&o.knowledge());
    assert_eq!(
        cached["assessment"]["items"][0]["evidence"][0]["path"],
        "retry.rs"
    );
    assert_eq!(step(&mut engine, &o, false).knowledge_support_reads, 0);
    crate::knowledge::settings::setup(&o.root, None, Some("trunk"), None).unwrap();
    assert!(step(&mut engine, &o, false).knowledge_assessed);
}

#[test]
fn anchor_watch_reuses_idle_and_rejects_cache_from_an_old_evaluator() {
    let mut f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine::default();
    let selector = crate::knowledge::evidence::Selector {
        version: 1,
        kind: "function".into(),
        name: "read_bytes".into(),
        owners: vec![],
    };
    f.store
        .learn_with_evidence(
            &f.checkout(),
            &support::actor(),
            crate::knowledge::model::KnowledgeKind::Invariant,
            "reader preserves",
            None,
            &[crate::knowledge::evidence::Spec {
                path: "reader.rs".into(),
                selector: Some(selector),
                provider: None,
            }],
        )
        .unwrap();
    assert!(step(&mut engine, &o, true).knowledge_assessed);
    let idle = step(&mut engine, &o, false);
    assert_eq!(idle.knowledge_support_reads, 0);
    assert_eq!(idle.knowledge_journal_replays, 0);
    let path = o.root.join(".mimirs/watch/knowledge.json");
    let mut snapshot: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    snapshot["evaluator"] = json!("previous evaluator with identical source and journal");
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert_eq!(knowledge::read(&o.knowledge())["origin"], "live");
    assert!(step(&mut Engine::default(), &o, true).knowledge_assessed);
    fs::write(
        o.root.join("reader.rs"),
        "// unrelated\nfn read_bytes() { preserve_original(); }\n",
    )
    .unwrap();
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    assert_eq!(
        knowledge::read(&o.knowledge())["assessment"]["items"][0]["status"],
        "Verified"
    );
    fs::write(
        o.root.join("reader.rs"),
        "fn renamed() { preserve_original(); }\n",
    )
    .unwrap();
    assert!(step(&mut engine, &o, false).knowledge_assessed);
    assert_eq!(
        knowledge::read(&o.knowledge())["assessment"]["items"][0]["status"],
        "NeedsRevalidation"
    );
}

#[test]
fn status_model_failure_and_retry_use_the_vector_component() {
    let f = Fixture::new();
    let o = options(&f);
    let mut engine = Engine {
        status: Some(crate::status::Activity::start(&o.root, "watch", "source")),
        ..Default::default()
    };
    let failed = engine
        .cycle(
            &o,
            true,
            || anyhow::bail!("model unavailable"),
            analysis::extract,
        )
        .unwrap();
    assert!(!failed.errors.is_empty());
    let read = || {
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(o.root.join(".mimirs/status")).unwrap(),
        )
        .unwrap()
    };
    let history = read()["failures"].clone();
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["component"] == "vectors_model")
    );
    assert!(step(&mut engine, &o, true).errors.is_empty());
    assert_eq!(read()["failures"], history);
    assert_eq!(read()["components"]["vectors_model"]["status"], "observed");
}
