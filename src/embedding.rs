use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};
use directories::BaseDirs;
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

pub const MODEL_NAME: &str = "all-MiniLM-L6-v2";
pub const DIMENSION: usize = 384;
const DOCUMENT_BATCH_SIZE: usize = 256;

pub trait Backend {
    fn prepare(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
}

type BackendFactory = Box<dyn FnMut() -> anyhow::Result<Box<dyn Backend>>>;

struct LazyBackend {
    factory: BackendFactory,
    backend: Option<Box<dyn Backend>>,
}

impl LazyBackend {
    fn new(factory: impl FnMut() -> anyhow::Result<Box<dyn Backend>> + 'static) -> Self {
        Self {
            factory: Box::new(factory),
            backend: None,
        }
    }

    fn get(&mut self) -> anyhow::Result<&mut dyn Backend> {
        if self.backend.is_none() {
            self.backend = Some((self.factory)()?);
        }

        Ok(self
            .backend
            .as_deref_mut()
            .expect("backend was initialized"))
    }
}

impl Backend for LazyBackend {
    fn prepare(&mut self) -> anyhow::Result<()> {
        self.get()?.prepare()
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.get()?.embed(texts)
    }
}

pub struct Embedder {
    backend: Box<dyn Backend>,
}

impl Embedder {
    pub fn new(backend: impl Backend + 'static) -> Self {
        Self {
            backend: Box::new(backend),
        }
    }

    fn lazy(factory: impl FnMut() -> anyhow::Result<Box<dyn Backend>> + 'static) -> Self {
        Self::new(LazyBackend::new(factory))
    }

    pub fn model_name(&self) -> &'static str {
        MODEL_NAME
    }

    pub fn dimension(&self) -> usize {
        DIMENSION
    }

    pub fn prepare(&mut self) -> anyhow::Result<()> {
        self.backend
            .prepare()
            .with_context(|| format!("cannot prepare embedding model {MODEL_NAME}"))
    }

    pub fn embed_documents(
        &mut self,
        texts: &[String],
        mut progress: impl FnMut(usize, usize),
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let total = texts.len();
        let mut vectors = Vec::with_capacity(total);

        for (batch_index, batch) in texts.chunks(DOCUMENT_BATCH_SIZE).enumerate() {
            let start = batch_index * DOCUMENT_BATCH_SIZE;
            let end = start + batch.len();
            let batch_vectors = self
                .backend
                .embed(batch)
                .with_context(|| format!("cannot embed documents {start}..{end}"))?;

            validate(&batch_vectors, batch.len())?;
            vectors.extend(batch_vectors);
            progress(end, total);
        }

        Ok(vectors)
    }

    pub fn embed_query(&mut self, query: &str) -> anyhow::Result<Vec<f32>> {
        let texts = [query.to_owned()];
        let mut vectors = self.backend.embed(&texts).context("cannot embed query")?;

        validate(&vectors, 1)?;
        Ok(vectors.pop().expect("one query vector was validated"))
    }
}

fn validate(vectors: &[Vec<f32>], expected_count: usize) -> anyhow::Result<()> {
    ensure!(
        vectors.len() == expected_count,
        "embedding backend returned {} vectors for {expected_count} inputs",
        vectors.len()
    );

    for (index, vector) in vectors.iter().enumerate() {
        ensure!(
            vector.len() == DIMENSION,
            "embedding {index} has dimension {}, expected {DIMENSION}",
            vector.len()
        );
        ensure!(
            vector.iter().all(|value| value.is_finite()),
            "embedding {index} contains a non-finite value"
        );
    }

    Ok(())
}

struct FastEmbedBackend {
    model: TextEmbedding,
}

impl Backend for FastEmbedBackend {
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.model.embed(texts, None).map_err(Into::into)
    }
}

pub fn model_cache_dir() -> anyhow::Result<PathBuf> {
    let base = BaseDirs::new().context("cannot resolve the operating system cache directory")?;
    Ok(base.cache_dir().join("mimirs").join("models"))
}

pub fn production() -> anyhow::Result<Embedder> {
    production_at(&model_cache_dir()?)
}

fn production_at(cache_dir: &Path) -> anyhow::Result<Embedder> {
    let cache_dir = cache_dir.to_owned();

    Ok(Embedder::lazy(move || {
        let options = TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir.clone())
            .with_show_download_progress(false);
        let model = TextEmbedding::try_new(options)
            .with_context(|| format!("cannot initialize embedding model {MODEL_NAME}"))?;

        Ok(Box::new(FastEmbedBackend { model }))
    }))
}

pub fn prepare_model() -> anyhow::Result<()> {
    production()?.prepare()
}

#[cfg(test)]
pub fn cosine_similarity(left: &[f32], right: &[f32]) -> anyhow::Result<f32> {
    ensure!(!left.is_empty(), "cosine vectors cannot be empty");
    ensure!(
        left.len() == right.len(),
        "cosine vectors have different dimensions: {} and {}",
        left.len(),
        right.len()
    );
    ensure!(
        left.iter().chain(right).all(|value| value.is_finite()),
        "cosine vectors contain a non-finite value"
    );

    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();

    ensure!(
        left_norm > 0.0 && right_norm > 0.0,
        "cosine vectors must have non-zero magnitude"
    );

    Ok((dot / (left_norm * right_norm)).clamp(-1.0, 1.0))
}

#[cfg(test)]
#[path = "../tests/unit/embedding.rs"]
mod tests;
