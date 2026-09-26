use std::path::{Path, PathBuf};

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

/// Load the tokenizer with truncation at the model's token limit.
pub fn load_tokenizer(path: &Path) -> Result<Tokenizer> {
    let mut tokenizer = Tokenizer::from_file(path).map_err(anyhow::Error::msg)?;
    tokenizer.with_padding(None);
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: MAX_TOKENS,
            ..Default::default()
        }))
        .map_err(anyhow::Error::msg)?;
    Ok(tokenizer)
}

/// Turns texts into vectors with the pinned model.
pub struct Embedder {
    tokenizer: Tokenizer,
    session: Session,
}

impl Embedder {
    pub fn load(files: &ModelFiles) -> Result<Self> {
        let tokenizer = load_tokenizer(&files.tokenizer)?;
        let session = Session::builder()?.commit_from_file(&files.model)?;
        Ok(Self { tokenizer, session })
    }

    /// Embed one text. One input per call means nothing is padded.
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(anyhow::Error::msg)?;
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
        let outputs = self.session.run(inputs)?;
        let (_, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        ensure!(
            hidden.len() == token_count * DIMENSION,
            "Unexpected model output size"
        );
        mean_pool_and_normalize(hidden, &mask)
    }
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
        let mut embedder = Embedder::load(&files)?;
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
}
