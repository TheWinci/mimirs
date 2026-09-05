use std::cell::RefCell;
use std::io;
use std::path::Path;
use std::rc::Rc;

use tempfile::TempDir;

use super::*;

fn vector(marker: f32) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSION];
    vector[0] = marker;
    vector
}

struct RecordingBackend {
    calls: Rc<RefCell<Vec<Vec<String>>>>,
}

impl Backend for RecordingBackend {
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.calls.borrow_mut().push(texts.to_vec());
        Ok(texts
            .iter()
            .map(|text| vector(text.parse::<f32>().unwrap_or(1.0)))
            .collect())
    }
}

struct ReplyBackend {
    reply: Option<anyhow::Result<Vec<Vec<f32>>>>,
}

impl Backend for ReplyBackend {
    fn embed(&mut self, _texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.reply.take().expect("test backend called once")
    }
}

#[test]
fn empty_documents_do_not_load_the_model_or_report_progress() {
    let dir = TempDir::new().unwrap();
    let cache = dir.path().join("models");
    let mut embedder = Embedder::new(FastEmbedBackend::new(cache.clone()));

    assert!(
        embedder
            .embed_documents(&[], |_, _| panic!("empty input reported progress"))
            .unwrap()
            .is_empty()
    );
    assert!(!cache.exists());
}

#[test]
fn documents_and_queries_use_the_same_backend() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut embedder = Embedder::new(RecordingBackend {
        calls: Rc::clone(&calls),
    });

    embedder.embed_query("1").unwrap();
    embedder
        .embed_documents(&["2".to_owned()], |_, _| Ok(()))
        .unwrap();

    assert_eq!(*calls.borrow(), [vec!["1"], vec!["2"]]);
}

#[test]
fn documents_keep_order_across_256_item_batches_and_report_progress() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut embedder = Embedder::new(RecordingBackend {
        calls: Rc::clone(&calls),
    });
    let texts = (0..257).map(|index| index.to_string()).collect::<Vec<_>>();
    let mut progress = Vec::new();

    let vectors = embedder
        .embed_documents(&texts, |completed, total| {
            progress.push((completed, total));
            Ok(())
        })
        .unwrap();

    assert_eq!(calls.borrow()[0].len(), 256);
    assert_eq!(calls.borrow()[1].len(), 1);
    assert_eq!(progress, [(256, 257), (257, 257)]);
    assert_eq!(
        vectors
            .iter()
            .map(|vector| vector[0] as usize)
            .collect::<Vec<_>>(),
        (0..257).collect::<Vec<_>>()
    );
}

#[test]
fn query_uses_one_ordered_backend_input() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut embedder = Embedder::new(RecordingBackend {
        calls: Rc::clone(&calls),
    });

    let query = embedder.embed_query("42").unwrap();

    assert_eq!(calls.borrow().as_slice(), &[vec!["42".to_owned()]]);
    assert_eq!(query[0], 42.0);
}

#[test]
fn backend_result_count_is_validated() {
    let mut embedder = Embedder::new(ReplyBackend {
        reply: Some(Ok(Vec::new())),
    });

    let error = embedder.embed_query("query").unwrap_err();

    assert!(
        error
            .to_string()
            .contains("embedding backend returned 0 vectors for 1 inputs")
    );
}

#[test]
fn vector_dimension_is_validated() {
    let mut embedder = Embedder::new(ReplyBackend {
        reply: Some(Ok(vec![vec![0.0; DIMENSION - 1]])),
    });

    let error = embedder.embed_query("query").unwrap_err();

    assert!(error.to_string().contains("dimension 383, expected 384"));
}

#[test]
fn non_finite_values_are_rejected() {
    let mut invalid = vector(1.0);
    invalid[10] = f32::NAN;
    let mut embedder = Embedder::new(ReplyBackend {
        reply: Some(Ok(vec![invalid])),
    });

    let error = embedder.embed_query("query").unwrap_err();

    assert!(error.to_string().contains("contains a non-finite value"));
}

#[test]
fn embedding_errors_keep_the_operation_and_cause() {
    let mut embedder = Embedder::new(ReplyBackend {
        reply: Some(Err(io::Error::other("backend exploded").into())),
    });

    let error = embedder.embed_query("query").unwrap_err();
    let message = format!("{error:#}");

    assert!(message.contains("cannot embed query"), "{message}");
    assert!(message.contains("backend exploded"), "{message}");
}

#[test]
fn preparation_errors_keep_the_operation_and_cause() {
    struct BrokenBackend;

    impl Backend for BrokenBackend {
        fn prepare(&mut self) -> anyhow::Result<()> {
            Err(io::Error::other("model files are corrupt").into())
        }

        fn embed(&mut self, _: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            panic!("preparation must not embed text")
        }
    }

    let mut embedder = Embedder::new(BrokenBackend);

    let error = embedder.prepare().unwrap_err();
    let message = format!("{error:#}");

    assert!(
        message.contains("cannot prepare embedding model all-MiniLM-L6-v2"),
        "{message}"
    );
    assert!(message.contains("model files are corrupt"), "{message}");
}

#[test]
fn cache_path_is_outside_the_project_and_names_mimirs_models() {
    let cache = model_cache_dir().unwrap();

    assert!(cache.ends_with(Path::new("mimirs").join("models")));
}

#[test]
fn progress_errors_stop_before_the_next_batch_and_keep_the_cause() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut embedder = Embedder::new(RecordingBackend {
        calls: Rc::clone(&calls),
    });
    let texts = vec!["1".to_owned(); 257];

    let error = embedder
        .embed_documents(&texts, |completed, total| {
            assert_eq!((completed, total), (256, 257));
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "progress output closed").into())
        })
        .unwrap_err();

    assert_eq!(calls.borrow().len(), 1);
    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::BrokenPipe
    );
}

/// Downloads the real model. Run with:
/// `cargo test real_minilm_documents_and_queries_reuse_the_cache -- --ignored --nocapture`
#[test]
#[ignore = "downloads the MiniLM model"]
fn real_minilm_documents_and_queries_reuse_the_cache() {
    let cache = TempDir::new().unwrap();
    let mut first = Embedder::new(FastEmbedBackend::new(cache.path().to_owned()));

    first.prepare().unwrap();
    first.prepare().unwrap();

    let documents = first
        .embed_documents(&["fn main() {}".to_owned()], |_, _| Ok(()))
        .unwrap();
    let query = first.embed_query("entry point").unwrap();

    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].len(), DIMENSION);
    assert_eq!(query.len(), DIMENSION);
    assert!(
        documents[0]
            .iter()
            .chain(&query)
            .all(|value| value.is_finite())
    );
    assert!(cache.path().read_dir().unwrap().next().is_some());

    drop(first);
    let mut second = Embedder::new(FastEmbedBackend::new(cache.path().to_owned()));
    assert_eq!(second.embed_query("entry point").unwrap().len(), DIMENSION);
}
