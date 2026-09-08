#![allow(dead_code)]
mod analysis;
mod collation;
mod config;
mod embedding;
mod profiling;
mod retrieval;
mod source;
mod storage;
use std::{path::Path, time::Instant};
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[1]);
    let query = &args[2];
    let start = Instant::now();
    let mut db = storage::open_read_only(&root.join(".mimirs/index.db"))?;
    let opened = Instant::now();
    let tx = db.transaction()?;
    storage::validate_model(&tx)?;
    let policy = storage::policy::read(&tx)?.ok_or_else(|| anyhow::anyhow!("missing policy"))?;
    anyhow::ensure!(storage::has_content(&tx)?, "empty index");
    let validated = Instant::now();
    let config = config::Config::load(root)?;
    let mut embedder = embedding::production()?;
    anyhow::ensure!(storage::policy::document_policy(&embedder.token_budget()?) == policy, "policy mismatch");
    let loaded = Instant::now();
    let vector = embedder.embed_ts_query(query)?;
    let embedded = Instant::now();
    let results = storage::hybrid::search(&tx, query, Some(&vector), 20, &config.generated, &policy)?;
    let retrieved = Instant::now();
    tx.commit()?;
    let end = Instant::now();
    let ms = |a: Instant, b: Instant| b.duration_since(a).as_secs_f64() * 1000.0;
    println!("{}", serde_json::json!({
        "database_open_and_validation_ms": ms(start, opened),
        "model_and_policy_validation_ms": ms(opened, validated),
        "model_load_and_tokenizer_ms": ms(validated, loaded),
        "query_embedding_ms": ms(loaded, embedded),
        "retrieval_and_evidence_ms": ms(embedded, retrieved),
        "transaction_commit_ms": ms(retrieved, end),
        "total_before_output_ms": ms(start, end),
        "paths": results.source.iter().map(|r| &r.hit.representative.path).collect::<Vec<_>>()
    }));
    Ok(())
}
