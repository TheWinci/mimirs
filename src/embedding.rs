use crate::profiling::Profiler;
use std::path::PathBuf;

use anyhow::{Context, ensure};
use directories::BaseDirs;
mod model;
use model::Model;

pub const MODEL_NAME: &str = "all-MiniLM-L6-v2-q8";
pub const MODEL_REVISION: &str = "751bff37182d3f1213fa05d7196b954e230abad9";
pub const MODEL_REPOSITORY: &str = "Xenova/all-MiniLM-L6-v2";
const MODEL_FILE: &str = "onnx/model_quantized.onnx";
// TS v2 pins its tokenizer with the model; documents are explicitly split at 256.
const TOKENIZER_REPOSITORY: &str = MODEL_REPOSITORY;
const TOKENIZER_REVISION: &str = MODEL_REVISION;
pub fn model_identity() -> String {
    format!("{MODEL_NAME}@{MODEL_REVISION}/tokenizer@{TOKENIZER_REVISION}/ort@1.22.0")
}

pub const DIMENSION: usize = 384;
#[cfg(test)]
const DOCUMENT_BATCH_SIZE: usize = 256;

mod pool;

pub trait Backend {
    fn embed_source_profiled(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        self.embed_profiled(texts, profile)
    }
    fn embed_query_text(&mut self, text: &str) -> anyhow::Result<Vec<Vec<f32>>> {
        self.embed(&[text.to_owned()])
    }

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

    #[cfg(test)]
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

    pub fn embed_ts_documents(
        &mut self,
        texts: &[String],
        mut progress: impl FnMut(usize, usize) -> anyhow::Result<()>,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        let mut output = Vec::new();
        for (i, batch) in texts.chunks(1024).enumerate() {
            let vectors = self.profile.measure("embedding", || {
                self.backend.embed_source_profiled(batch, &self.profile)
            })?;
            validate(&vectors, batch.len())?;
            output.extend(vectors);
            progress((i * 1024 + batch.len()).min(texts.len()), texts.len())?;
        }
        Ok(output)
    }

    pub fn embed_ts_query(&mut self, query: &str) -> anyhow::Result<Vec<f32>> {
        let mut vectors = self
            .backend
            .embed_query_text(query)
            .context("cannot embed query")?;
        validate(&vectors, 1)?;
        Ok(vectors.remove(0))
    }

    #[cfg(test)]
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

struct OnnxBackend {
    cache_dir: PathBuf,
    models: Vec<Model>,
    workers: usize,
    profile: Profiler,
}

impl OnnxBackend {
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
            let tokenizer = read_tokenizer("tokenizer.json")?;
            let weights = read(MODEL_REPOSITORY, MODEL_REVISION, MODEL_FILE)?;
            self.models.push(
                self.profile
                    .measure("model_startup", || Model::new(&weights, &tokenizer))
                    .with_context(|| {
                        format!("cannot initialize embedding model {MODEL_NAME}@{MODEL_REVISION}")
                    })?,
            );
        }

        Ok(())
    }

    fn model(&mut self) -> anyhow::Result<&mut Model> {
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
            let mut vectors = model.embed(&[text])?;
            validate(&vectors, 1)?;
            Ok(vectors.remove(0))
        })
    }
}

impl Backend for OnnxBackend {
    fn embed_source_profiled(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let tokenizer = ts_v2::unbounded(self.model()?.tokenizer.clone())?;
        let mut unique = Vec::new();
        let mut indexes = std::collections::HashMap::new();
        let mut plans = Vec::new();
        for text in texts {
            let mut plan = Vec::new();
            for input in ts_v2::document_inputs(&tokenizer, text)? {
                let index = *indexes.entry(input.clone()).or_insert_with(|| {
                    let index = unique.len();
                    unique.push(input);
                    index
                });
                plan.push(index);
            }
            plans.push(plan);
        }
        let vectors = self.embed_chunks(&unique, profile)?;
        plans
            .into_iter()
            .map(|plan| {
                ts_v2::merge(
                    &plan
                        .iter()
                        .map(|&i| vectors[i].as_slice())
                        .collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    fn embed_query_text(&mut self, text: &str) -> anyhow::Result<Vec<Vec<f32>>> {
        let tokenizer = ts_v2::unbounded(self.model()?.tokenizer.clone())?;
        let windows = ts_v2::query_inputs(&tokenizer, text)?;
        let mut order: Vec<_> = (0..windows.len()).collect();
        order.sort_by_key(|&i| (windows[i].1, i));
        let mut vectors = vec![Vec::new(); windows.len()];
        for batch in order.chunks(32) {
            let texts: Vec<_> = batch.iter().map(|&i| windows[i].0.as_str()).collect();
            let outputs = self.model()?.embed(&texts)?;
            validate(&outputs, batch.len())?;
            for (&index, output) in batch.iter().zip(outputs) {
                vectors[index] = output;
            }
        }
        Ok(vec![ts_v2::merge(
            &vectors.iter().map(Vec::as_slice).collect::<Vec<_>>(),
        )?])
    }

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
    let mut backend = OnnxBackend::new(match cache_dir {
        Some(path) => path,
        None => model_cache_dir()?,
    });
    backend.profile = profile.clone();
    Ok(Embedder::new(backend).with_profile(profile))
}

#[cfg(test)]
#[path = "../tests/unit/embedding.rs"]
mod tests;

pub mod ts_v2;
