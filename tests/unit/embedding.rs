use std::cell::{Cell, RefCell};
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
fn identity_is_independent_of_the_backend() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let embedder = Embedder::new(RecordingBackend { calls });

    assert_eq!(embedder.model_name(), "all-MiniLM-L6-v2");
    assert_eq!(embedder.dimension(), 384);
}

#[test]
fn one_lazy_backend_is_reused_for_documents_and_queries() {
    let creations = Rc::new(Cell::new(0));
    let calls = Rc::new(RefCell::new(Vec::new()));
    let factory_creations = Rc::clone(&creations);
    let factory_calls = Rc::clone(&calls);
    let mut embedder = Embedder::lazy(move || {
        factory_creations.set(factory_creations.get() + 1);
        Ok(Box::new(RecordingBackend {
            calls: Rc::clone(&factory_calls),
        }))
    });

    assert!(
        embedder
            .embed_documents(&[], |_, _| panic!("empty input reported progress"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(creations.get(), 0);

    embedder.embed_query("1").unwrap();
    embedder
        .embed_documents(&["2".to_owned()], |_, _| {})
        .unwrap();

    assert_eq!(creations.get(), 1);
    assert_eq!(calls.borrow().len(), 2);
}

#[test]
fn explicit_preparation_initializes_the_lazy_backend_once() {
    let creations = Rc::new(Cell::new(0));
    let factory_creations = Rc::clone(&creations);
    let mut embedder = Embedder::lazy(move || {
        factory_creations.set(factory_creations.get() + 1);
        Ok(Box::new(RecordingBackend {
            calls: Rc::new(RefCell::new(Vec::new())),
        }))
    });

    embedder.prepare().unwrap();
    embedder.prepare().unwrap();
    embedder.embed_query("1").unwrap();

    assert_eq!(creations.get(), 1);
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
    let mut embedder = Embedder::lazy(|| Err(io::Error::other("model files are corrupt").into()));

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
fn scalar_cosine_handles_known_vectors() {
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]).unwrap(), 1.0);
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).unwrap(), 0.0);
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]).unwrap(), -1.0);
}

/// Downloads the real model. Run with:
/// `cargo test real_minilm_documents_and_queries_reuse_the_cache -- --ignored --nocapture`
#[test]
#[ignore = "downloads the MiniLM model"]
fn real_minilm_documents_and_queries_reuse_the_cache() {
    let cache = TempDir::new().unwrap();
    let mut first = production_at(cache.path()).unwrap();

    let documents = first
        .embed_documents(&["fn main() {}".to_owned()], |_, _| {})
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
    let mut second = production_at(cache.path()).unwrap();
    assert_eq!(second.embed_query("entry point").unwrap().len(), DIMENSION);
}
