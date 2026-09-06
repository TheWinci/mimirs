use super::Evidence;
use anyhow::{Context, Result, ensure};
use tokenizers::Tokenizer;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Document {
    #[serde(default)]
    pub source_chunk: Option<usize>,
    pub owner: Option<usize>,
    pub part: usize,
    pub text: String,
    pub evidence: Vec<Evidence>,
}

pub struct TokenBudget {
    tokenizer: Tokenizer,
    pub limit: usize,
    pub fingerprint: String,
}

impl TokenBudget {
    pub fn new(mut tokenizer: Tokenizer) -> Result<Self> {
        let limit = tokenizer
            .get_truncation()
            .context("backend tokenizer has no sequence limit")?
            .max_length;
        let fingerprint = crate::storage::processing::source_hash(
            &tokenizer.to_string(false).map_err(|e| anyhow::anyhow!(e))?,
        );
        tokenizer
            .with_truncation(None)
            .map_err(|e| anyhow::anyhow!(e))?;
        tokenizer.with_padding(None);
        ensure!(limit > 8, "token limit too small for entity context");
        Ok(Self {
            tokenizer,
            limit,
            fingerprint,
        })
    }

    pub fn count(&self, text: &str) -> Result<usize> {
        Ok(self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!(e))?
            .len())
    }

    pub(super) fn prefix_end(&self, prefix: &str, text: &str, limit: usize) -> Result<usize> {
        let encoding = self
            .tokenizer
            .encode(text, false)
            .map_err(|e| anyhow::anyhow!(e))?;
        let mut ends: Vec<_> = encoding
            .get_offsets()
            .iter()
            .map(|&(_, end)| end)
            .filter(|&end| end > 0 && text.is_char_boundary(end))
            .collect();
        ends.push(text.len());
        ends.sort_unstable();
        ends.dedup();
        let mut best = 0;
        // Binary search only chooses a fitting boundary; maximal packing is not required.
        let (mut low, mut high) = (0, ends.len());
        while low < high {
            let mid = (low + high) / 2;
            if self.count(&format!("{prefix}{}", &text[..ends[mid]]))? <= limit {
                best = ends[mid];
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        ensure!(best > 0, "one token cannot fit with entity context");
        Ok(best)
    }
}
