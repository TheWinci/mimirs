use std::path::PathBuf;

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

    #[allow(dead_code)] // Connected to Rust indexing in S6.
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        anyhow::bail!("embedding backend does not expose a tokenizer")
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
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

    pub fn prepare(&mut self) -> anyhow::Result<()> {
        self.backend
            .prepare()
            .with_context(|| format!("cannot prepare embedding model {MODEL_NAME}"))
    }

    #[allow(dead_code)] // Connected to Rust indexing in S6.
    pub fn token_budget(&mut self) -> anyhow::Result<crate::retrieval::split::TokenBudget> {
        crate::retrieval::split::TokenBudget::new(self.backend.tokenizer()?)
    }

    pub fn embed_documents(
        &mut self,
        texts: &[String],
        mut progress: impl FnMut(usize, usize) -> anyhow::Result<()>,
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
            progress(end, total)?;
        }

        Ok(vectors)
    }

    pub fn embed_query(&mut self, query: &str) -> anyhow::Result<Vec<f32>> {
        let texts = [query.to_owned()];
        let mut vectors = self.backend.embed(&texts).context("cannot embed query")?;

        validate(&vectors, 1)?;
        vectors
            .pop()
            .context("embedding backend returned no query vector")
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
    cache_dir: PathBuf,
    model: Option<TextEmbedding>,
}

impl FastEmbedBackend {
    fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            model: None,
        }
    }

    fn model(&mut self) -> anyhow::Result<&mut TextEmbedding> {
        if self.model.is_none() {
            let options = TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
                .with_cache_dir(self.cache_dir.clone())
                .with_show_download_progress(false);
            self.model = Some(
                TextEmbedding::try_new(options)
                    .with_context(|| format!("cannot initialize embedding model {MODEL_NAME}"))?,
            );
        }

        self.model
            .as_mut()
            .context("embedding model is not initialized")
    }
}

impl Backend for FastEmbedBackend {
    fn prepare(&mut self) -> anyhow::Result<()> {
        self.model()?;
        Ok(())
    }

    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(self.model()?.tokenizer.clone())
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.model()?.embed(texts, None).map_err(Into::into)
    }
}

fn model_cache_dir() -> anyhow::Result<PathBuf> {
    let base = BaseDirs::new().context("cannot resolve the operating system cache directory")?;
    Ok(base.cache_dir().join("mimirs").join("models"))
}

pub fn production() -> anyhow::Result<Embedder> {
    Ok(Embedder::new(FastEmbedBackend::new(model_cache_dir()?)))
}

#[cfg(test)]
#[path = "../tests/unit/embedding.rs"]
mod tests;
