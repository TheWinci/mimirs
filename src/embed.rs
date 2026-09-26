use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use anyhow::{Context, Result, ensure};
use hf_hub::api::sync::ApiBuilder;
use hf_hub::{Cache, Repo, RepoType};
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::{Tokenizer, TruncationParams};

/// Length of every vector the model produces.
pub const DIMENSION: usize = 384;
/// Most tokens the model sees in one input, including its two special tokens.
pub const MAX_TOKENS: usize = 256;

const REPOSITORY: &str = "Xenova/all-MiniLM-L6-v2";
// Pinned so an upstream update cannot change vectors without a mimirs release.
const REVISION: &str = "751bff37182d3f1213fa05d7196b954e230abad9";
const MODEL_FILE: &str = "onnx/model_quantized.onnx";
const TOKENIZER_FILE: &str = "tokenizer.json";

/// Paths of the cached model files.
pub struct ModelFiles {
    pub model: PathBuf,
    pub tokenizer: PathBuf,
}

/// The machine-wide folder that holds downloaded model files.
pub fn cache_dir() -> Result<PathBuf> {
    let cache = dirs::cache_dir().context("Could not find this machine's cache folder")?;
    Ok(cache.join("mimirs"))
}

fn pinned_repo() -> Repo {
    Repo::with_revision(REPOSITORY.into(), RepoType::Model, REVISION.into())
}

/// Return the model files when both are already in `cache`.
pub fn cached_files(cache: &Path) -> Option<ModelFiles> {
    let repo = Cache::new(cache.to_path_buf()).repo(pinned_repo());
    Some(ModelFiles {
        model: repo.get(MODEL_FILE)?,
        tokenizer: repo.get(TOKENIZER_FILE)?,
    })
}

/// Download the model files into `cache`, reusing any that are already there.
pub fn download(cache: &Path) -> Result<ModelFiles> {
    let api = ApiBuilder::new()
        .with_cache_dir(cache.to_path_buf())
        .with_progress(false)
        .build()?;
    let repo = api.repo(pinned_repo());
    let model = repo
        .get(MODEL_FILE)
        .with_context(|| format!("Could not download {REPOSITORY}/{MODEL_FILE}"))?;
    let tokenizer = repo
        .get(TOKENIZER_FILE)
        .with_context(|| format!("Could not download {REPOSITORY}/{TOKENIZER_FILE}"))?;
    Ok(ModelFiles { model, tokenizer })
}

/// Load the tokenizer without truncation or padding, so it counts every token.
pub fn load_tokenizer(path: &Path) -> Result<Tokenizer> {
    let mut tokenizer = Tokenizer::from_file(path).map_err(anyhow::Error::msg)?;
    tokenizer.with_padding(None);
    tokenizer
        .with_truncation(None)
        .map_err(anyhow::Error::msg)?;
    Ok(tokenizer)
}

/// Vectors one worker embedded, each with its text's position in the input.
type PositionedVectors = Vec<(usize, Vec<f32>)>;

/// Turns texts into vectors with the pinned model.
pub struct Embedder {
    tokenizer: Tokenizer,
    /// One model instance per thread. A single ~250-token input is too small to
    /// split well across threads, so instances run side by side instead.
    sessions: Vec<Session>,
}

impl Embedder {
    /// Load `instances` copies of the model, each running on one CPU thread.
    pub fn load(files: &ModelFiles, instances: usize) -> Result<Self> {
        ensure!(instances > 0, "At least one model instance is needed");
        let mut tokenizer = load_tokenizer(&files.tokenizer)?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(anyhow::Error::msg)?;
        let mut sessions = Vec::with_capacity(instances);
        for _ in 0..instances {
            let session = Session::builder()?
                .with_intra_threads(1)?
                .commit_from_file(&files.model)?;
            sessions.push(session);
        }
        Ok(Self {
            tokenizer,
            sessions,
        })
    }

    /// Embed one text with the first model instance.
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let session = self
            .sessions
            .first_mut()
            .context("At least one model instance is needed")?;
        embed_with(session, &self.tokenizer, text)
    }

    /// Embed many texts, keeping their order. Each model instance runs on its own
    /// thread and takes the next unclaimed text until none are left.
    pub fn embed_all(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let next_text = AtomicUsize::new(0);
        let tokenizer = &self.tokenizer;
        let worker_results: Vec<Result<PositionedVectors>> = thread::scope(|scope| {
            let workers: Vec<_> = self
                .sessions
                .iter_mut()
                .map(|session| {
                    let next_text = &next_text;
                    scope.spawn(move || {
                        let mut embedded = Vec::new();
                        loop {
                            let index = next_text.fetch_add(1, Ordering::Relaxed);
                            let Some(text) = texts.get(index) else {
                                break;
                            };
                            embedded.push((index, embed_with(session, tokenizer, text)?));
                        }
                        Ok(embedded)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("An embedding thread panicked")))
                })
                .collect()
        });

        let mut vectors = vec![Vec::new(); texts.len()];
        for result in worker_results {
            for (index, vector) in result? {
                vectors[index] = vector;
            }
        }
        Ok(vectors)
    }
}

/// Embed one text with one model instance. One input per call means nothing is padded.
fn embed_with(session: &mut Session, tokenizer: &Tokenizer, text: &str) -> Result<Vec<f32>> {
    let encoding = tokenizer.encode(text, true).map_err(anyhow::Error::msg)?;
    let token_count = encoding.len();
    let shape = [1, token_count];
    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&value| value as i64)
        .collect();
    let type_ids: Vec<i64> = encoding
        .get_type_ids()
        .iter()
        .map(|&id| id as i64)
        .collect();
    let inputs = ort::inputs![
        "input_ids" => Tensor::from_array((shape, ids))?,
        "attention_mask" => Tensor::from_array((shape, mask.clone()))?,
        "token_type_ids" => Tensor::from_array((shape, type_ids))?,
    ];
    let outputs = session.run(inputs)?;
    let (_, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
    ensure!(
        hidden.len() == token_count * DIMENSION,
        "Unexpected model output size"
    );
    mean_pool_and_normalize(hidden, &mask)
}

/// Average the token vectors the attention mask marks as real, then scale to unit length.
fn mean_pool_and_normalize(hidden: &[f32], mask: &[i64]) -> Result<Vec<f32>> {
    let visible_tokens = mask.iter().filter(|&&value| value == 1).count();
    ensure!(visible_tokens > 0, "Embedding input has no tokens");

    let mut vector = vec![0.0_f32; DIMENSION];
    for (token, token_vector) in hidden.chunks_exact(DIMENSION).enumerate() {
        if mask[token] == 1 {
            for (sum, value) in vector.iter_mut().zip(token_vector) {
                *sum += value;
            }
        }
    }
    for value in &mut vector {
        *value /= visible_tokens as f32;
    }

    let length = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    ensure!(length > 0.0, "Embedding has zero length");
    for value in &mut vector {
        *value /= length;
    }
    Ok(vector)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooling_averages_visible_tokens_and_normalizes() -> Result<()> {
        let mut hidden = vec![0.0_f32; DIMENSION * 3];
        hidden[0] = 2.0; // token 0
        hidden[DIMENSION] = 4.0; // token 1
        hidden[DIMENSION * 2 + 1] = 100.0; // token 2, masked out
        let vector = mean_pool_and_normalize(&hidden, &[1, 1, 0])?;
        assert_eq!(vector.len(), DIMENSION);
        assert!((vector[0] - 1.0).abs() < 1e-6);
        assert_eq!(vector[1], 0.0);
        Ok(())
    }

    #[test]
    fn pooling_rejects_inputs_without_tokens() {
        let hidden = vec![1.0_f32; DIMENSION];
        assert!(mean_pool_and_normalize(&hidden, &[0]).is_err());
    }

    fn similarity(left: &[f32], right: &[f32]) -> f32 {
        left.iter().zip(right).map(|(a, b)| a * b).sum()
    }

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn related_sentences_are_closer_than_unrelated_ones() -> Result<()> {
        let files = download(&cache_dir()?)?;
        let mut embedder = Embedder::load(&files, 3)?;
        let refresh = embedder.embed("refresh the access token before it expires")?;
        let renew = embedder.embed("renew an expiring authentication token")?;
        let pasta = embedder.embed("boil the pasta for nine minutes")?;

        assert_eq!(refresh.len(), DIMENSION);
        let length = refresh
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        assert!((length - 1.0).abs() < 1e-4);
        assert!(similarity(&refresh, &renew) > similarity(&refresh, &pasta));
        Ok(())
    }

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn parallel_embedding_matches_one_at_a_time_in_order() -> Result<()> {
        let files = download(&cache_dir()?)?;
        let mut embedder = Embedder::load(&files, 3)?;
        let texts: Vec<String> = (0..10)
            .map(|number| format!("function number {number}"))
            .collect();
        let text_refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let together = embedder.embed_all(&text_refs)?;
        assert_eq!(together.len(), texts.len());
        for (text, vector) in texts.iter().zip(&together) {
            let alone = embedder.embed(text)?;
            let difference = alone
                .iter()
                .zip(vector)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(difference < 1e-5);
        }
        Ok(())
    }
}
