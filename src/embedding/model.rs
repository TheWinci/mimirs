//! Fixed MiniLM inference with one CPU thread per session. Keeping pooling here
//! makes TS's float64 accumulation and float32 storage explicit.
use super::DIMENSION;
use anyhow::{Context, Result, ensure};
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use tokenizers::{PaddingParams, Tokenizer, TruncationParams};

pub(super) struct Model {
    pub tokenizer: Tokenizer,
    session: Session,
}

impl Model {
    pub fn new(weights: &[u8], tokenizer: &[u8]) -> Result<Self> {
        let mut tokenizer = Tokenizer::from_bytes(tokenizer).map_err(anyhow::Error::msg)?;
        tokenizer.with_padding(Some(PaddingParams::default()));
        // TS decodes query windows before inference, which can add special tokens.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 512,
                ..Default::default()
            }))
            .map_err(anyhow::Error::msg)?;
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(1)?
            .with_inter_threads(1)?
            .commit_from_memory(weights)?;
        Ok(Self { tokenizer, session })
    }

    pub fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(anyhow::Error::msg)?;
        let length = encodings.first().context("empty tokenization")?.len();
        let shape = [texts.len(), length];
        ensure!(
            encodings.iter().all(|e| e.len() == length),
            "inconsistent padded input lengths"
        );
        let ids = encodings
            .iter()
            .flat_map(|e| e.get_ids().iter().map(|&v| v as i64))
            .collect::<Vec<_>>();
        let mask = encodings
            .iter()
            .flat_map(|e| e.get_attention_mask().iter().map(|&v| v as i64))
            .collect::<Vec<_>>();
        let types = encodings
            .iter()
            .flat_map(|e| e.get_type_ids().iter().map(|&v| v as i64))
            .collect::<Vec<_>>();
        let outputs = self.session.run(ort::inputs![
            "input_ids" => Tensor::from_array((shape, ids))?,
            "attention_mask" => Tensor::from_array((shape, mask.clone()))?,
            "token_type_ids" => Tensor::from_array((shape, types))?,
        ])?;
        let (dims, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        ensure!(
            dims.as_ref() == [texts.len() as i64, length as i64, DIMENSION as i64],
            "unexpected MiniLM output shape"
        );
        hidden
            .chunks_exact(length * DIMENSION)
            .zip(mask.chunks_exact(length))
            .map(|(hidden, mask)| pool(hidden, mask))
            .collect()
    }
}

fn pool(hidden: &[f32], mask: &[i64]) -> Result<Vec<f32>> {
    let count: i64 = mask.iter().sum();
    ensure!(count > 0, "embedding input has no visible tokens");
    let mut vector = vec![0.0_f32; DIMENSION];
    for (dimension, value) in vector.iter_mut().enumerate() {
        let sum: f64 = mask
            .iter()
            .enumerate()
            .map(|(i, &mask)| hidden[i * DIMENSION + dimension] as f64 * mask as f64)
            .sum();
        *value = (sum / count as f64) as f32;
    }
    // Transformers.js stores the sum and its square root in float32 tensors.
    let sum = vector.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() as f32;
    let norm = (sum as f64).sqrt() as f32;
    ensure!(
        norm.is_finite() && norm > 0.0,
        "invalid pooled embedding norm"
    );
    for v in &mut vector {
        *v = (*v as f64 / norm as f64) as f32;
    }
    Ok(vector)
}
