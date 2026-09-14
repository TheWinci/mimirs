//! Reusable retrieval request; the CLI and future local tool adapters share this operation.
use super::compact::Prepared;
use crate::{embedding, storage};
use anyhow::{Result, ensure};
use std::path::Path;
use storage::hybrid::Response;

#[derive(Default)]
pub struct Retriever {
    embedder: Option<embedding::Embedder>,
}
pub struct Retrieved {
    pub navigation: Option<serde_json::Value>,
    pub results: Response,
    pub compact: Option<Prepared>,
}
impl Retriever {
    pub fn retrieve(
        &mut self,
        root: &Path,
        query: &str,
        limit: usize,
        compact: bool,
        make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
    ) -> Result<Retrieved> {
        self.retrieve_with_intent(
            root,
            query,
            limit,
            compact,
            make_embedder,
            super::navigation::Intent::Task,
            &mut |_| None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn retrieve_with_intent(
        &mut self,
        root: &Path,
        query: &str,
        limit: usize,
        compact: bool,
        make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
        intent: super::navigation::Intent,
        observe: &mut impl FnMut(&str) -> Option<String>,
    ) -> Result<Retrieved> {
        ensure!(!query.trim().is_empty(), "query must not be blank");
        ensure!(
            (1..=100).contains(&limit),
            "limit must be between 1 and 100"
        );
        let mut connection = storage::open_read_only(&root.join(".mimirs/index.db"))?;
        // Metadata, candidates, and every citation share one saved-source snapshot.
        let transaction = connection.transaction()?;
        storage::validate_model(&transaction)?;
        let policy = storage::policy::read_for_search(&transaction)?;
        let mut results = if storage::has_content(&transaction)? {
            let config = crate::config::Config::load(root)?;
            if self.embedder.is_none() {
                self.embedder = Some(make_embedder()?);
            }
            let embedder = self.embedder.as_mut().expect("initialized embedder");
            let policy = policy
                .as_deref()
                .expect("validated populated index has a policy");
            ensure!(
                storage::policy::document_policy(&embedder.token_budget()?) == policy,
                "query tokenizer does not match indexed document policy; run mimirs index"
            );
            let vector = embedder.embed_ts_query(query)?;
            storage::hybrid::search(
                &transaction,
                query,
                Some(&vector),
                limit,
                &config.generated,
                policy,
            )?
        } else {
            Response {
                source: Vec::new(),
                docs: Vec::new(),
                relations: Vec::new(),
            }
        };
        let navigation = intent.architecture(query).then(|| {
            super::navigation::expand(
                root,
                &transaction,
                &mut results,
                query,
                limit,
                policy.as_deref(),
                observe,
            )
        });
        let compact = if compact {
            Some(Prepared::new(&transaction, &results)?)
        } else {
            None
        };
        transaction.commit()?;
        Ok(Retrieved {
            results,
            compact,
            navigation,
        })
    }
}
