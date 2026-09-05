use super::render::{Clause, Description, Evidence};
use anyhow::{Context, Result, ensure};
use tokenizers::Tokenizer;

pub const TOKEN_POLICY: &str = "fact-boundaries-1";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Document {
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

    fn prefix_end(&self, prefix: &str, text: &str, limit: usize) -> Result<usize> {
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

    pub fn split(&self, descriptions: &[Description]) -> Result<Vec<Document>> {
        let mut output = Vec::new();
        for description in descriptions {
            let mut clauses: Vec<&Clause> = description.facts.iter().collect();
            let identity = if self.count(&description.identity.text)? <= self.limit / 2 {
                description.identity.text.clone()
            } else {
                clauses.insert(0, &description.identity);
                let end = self.prefix_end("", &description.identity.text, self.limit / 4)?;
                format!("{} …", &description.identity.text[..end])
            };
            let mut part = 0;
            let mut text = identity.clone();
            let mut evidence = description.identity.evidence.clone();
            for clause in clauses {
                let mut remaining = clause.text.as_str();
                while !remaining.is_empty() {
                    let combined = format!("{text}\n{remaining}");
                    if self.count(&combined)? <= self.limit {
                        text = combined;
                        evidence.extend(clause.evidence.clone());
                        break;
                    }
                    if text != identity {
                        output.push(Document {
                            owner: description.owner,
                            part,
                            text,
                            evidence,
                        });
                        part += 1;
                        text = identity.clone();
                        evidence = description.identity.evidence.clone();
                        continue;
                    }
                    let prefix = format!("{identity}\n");
                    let end = self.prefix_end(&prefix, remaining, self.limit)?;
                    text = format!("{prefix}{}", &remaining[..end]);
                    evidence.extend(clause.evidence.clone());
                    remaining = &remaining[end..];
                    output.push(Document {
                        owner: description.owner,
                        part,
                        text,
                        evidence,
                    });
                    part += 1;
                    text = identity.clone();
                    evidence = description.identity.evidence.clone();
                }
            }
            if text != identity || part == 0 {
                output.push(Document {
                    owner: description.owner,
                    part,
                    text,
                    evidence,
                });
            }
        }
        for document in &output {
            ensure!(
                self.count(&document.text)? <= self.limit,
                "document exceeds tokenizer limit"
            );
        }
        Ok(output)
    }
}
