use crate::profiling::Profiler;
use std::path::PathBuf;

use anyhow::{Context, ensure};
use directories::BaseDirs;
use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};

pub const MODEL_NAME: &str = "all-MiniLM-L6-v2-q8";
pub const MODEL_REVISION: &str = "751bff37182d3f1213fa05d7196b954e230abad9";
pub const MODEL_REPOSITORY: &str = "Xenova/all-MiniLM-L6-v2";
const MODEL_FILE: &str = "onnx/model_quantized.onnx";
// Keep the tokenizer used in the benchmark, including its 512-token limit.
const TOKENIZER_REPOSITORY: &str = "Qdrant/all-MiniLM-L6-v2-onnx";
const TOKENIZER_REVISION: &str = "5f1b8cd78bc4fb444dd171e59b18f3a3af89a079";
pub fn model_identity() -> String {
    format!("{MODEL_NAME}@{MODEL_REVISION}/tokenizer@{TOKENIZER_REVISION}")
}

pub const DIMENSION: usize = 384;
const DOCUMENT_BATCH_SIZE: usize = 256;

mod pool;

pub trait Backend {
    fn set_workers(&mut self, _workers: usize) {}

    fn embed_profiled(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        profile.batch(texts.len());
        self.embed(texts)
    }

    fn prepare(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        anyhow::bail!("embedding backend does not expose a tokenizer")
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>>;
}

pub struct Embedder {
    backend: Box<dyn Backend>,
    profile: Profiler,
}

impl Embedder {
    pub fn with_workers(mut self, workers: usize) -> Self {
        self.backend.set_workers(workers.max(1));
        self
    }

    pub fn new(backend: impl Backend + 'static) -> Self {
        Self {
            backend: Box::new(backend),
            profile: Profiler::default(),
        }
    }

    pub fn with_profile(mut self, profile: Profiler) -> Self {
        self.profile = profile;
        self
    }

    pub fn prepare(&mut self) -> anyhow::Result<()> {
        self.backend
            .prepare()
            .with_context(|| format!("cannot prepare embedding model {MODEL_NAME}"))
    }

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
                .profile
                .measure("embedding", || {
                    self.backend.embed_profiled(batch, &self.profile)
                })
                .with_context(|| format!("cannot embed documents {start}..{end}"))?;

            self.profile.measure("vector_validation", || {
                validate(&batch_vectors, batch.len())
            })?;
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
    models: Vec<TextEmbedding>,
    workers: usize,
    profile: Profiler,
}

impl FastEmbedBackend {
    fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            models: Vec::new(),
            workers: 1,
            profile: Profiler::default(),
        }
    }

    fn ensure_models(&mut self, count: usize) -> anyhow::Result<()> {
        while self.models.len() < count {
            let api = hf_hub::api::sync::ApiBuilder::new()
                .with_cache_dir(self.cache_dir.clone())
                .with_progress(false)
                .build()?;
            let read = |repository: &str, revision: &str, name: &str| -> anyhow::Result<Vec<u8>> {
                let repository = hf_hub::Repo::with_revision(
                    repository.into(),
                    hf_hub::RepoType::Model,
                    revision.into(),
                );
                let cached = hf_hub::Cache::new(self.cache_dir.clone()).repo(repository.clone());
                let repo = api.repo(repository);
                self.profile.measure("model_assets", || {
                    let present = cached.get(name).is_some();
                    let path = repo.get(name)?;
                    let bytes = std::fs::read(path)?;
                    self.profile.count("model_asset_bytes", bytes.len());
                    self.profile.count(
                        if present {
                            "model_assets_cached"
                        } else {
                            "model_assets_fetched"
                        },
                        1,
                    );
                    if !present {
                        self.profile.count("model_fetched_bytes", bytes.len());
                    }
                    Ok(bytes)
                })
            };
            let read_tokenizer = |name| read(TOKENIZER_REPOSITORY, TOKENIZER_REVISION, name);
            let files = TokenizerFiles {
                tokenizer_file: read_tokenizer("tokenizer.json")?,
                config_file: read_tokenizer("config.json")?,
                special_tokens_map_file: read_tokenizer("special_tokens_map.json")?,
                tokenizer_config_file: read_tokenizer("tokenizer_config.json")?,
            };
            let model = UserDefinedEmbeddingModel::new(
                read(MODEL_REPOSITORY, MODEL_REVISION, MODEL_FILE)?,
                files,
            )
            .with_pooling(Pooling::Mean)
            .with_quantization(QuantizationMode::Dynamic);
            self.models.push(
                self.profile
                    .measure("model_startup", || {
                        TextEmbedding::try_new_from_user_defined(
                            model,
                            InitOptionsUserDefined::new()
                                .with_max_length(512)
                                .with_intra_threads(1),
                        )
                    })
                    .with_context(|| {
                        format!("cannot initialize embedding model {MODEL_NAME}@{MODEL_REVISION}")
                    })?,
            );
        }

        Ok(())
    }

    fn model(&mut self) -> anyhow::Result<&mut TextEmbedding> {
        self.ensure_models(1)?;
        Ok(&mut self.models[0])
    }

    fn embed_chunks(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let count = self.workers.min(texts.len());
        self.ensure_models(count)?;
        pool::embed(&mut self.models[..count], texts, profile, |model, text| {
            let mut vectors = model.embed([text], Some(1))?;
            validate(&vectors, 1)?;
            Ok(vectors.remove(0))
        })
    }
}

impl Backend for FastEmbedBackend {
    fn set_workers(&mut self, workers: usize) {
        self.workers = workers;
        self.models.truncate(workers);
    }

    fn embed_profiled(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        self.embed_chunks(texts, profile)
    }

    fn prepare(&mut self) -> anyhow::Result<()> {
        self.model()?;
        Ok(())
    }

    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(self.model()?.tokenizer.clone())
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.embed_chunks(texts, &Profiler::default())
    }
}

fn model_cache_dir() -> anyhow::Result<PathBuf> {
    let base = BaseDirs::new().context("cannot resolve the operating system cache directory")?;
    Ok(base.cache_dir().join("mimirs").join("models"))
}

pub fn production() -> anyhow::Result<Embedder> {
    production_profiled(None, Profiler::default())
}

pub fn production_profiled(
    cache_dir: Option<PathBuf>,
    profile: Profiler,
) -> anyhow::Result<Embedder> {
    // Tokenization of a single input needs no additional global worker pool.
    tokenizers::utils::parallelism::set_parallelism(false);
    let mut backend = FastEmbedBackend::new(match cache_dir {
        Some(path) => path,
        None => model_cache_dir()?,
    });
    backend.profile = profile.clone();
    Ok(Embedder::new(backend).with_profile(profile))
}

#[cfg(test)]
#[path = "../tests/unit/embedding.rs"]
mod tests;
