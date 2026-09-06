//! Compare per-file embedding with a queue containing the whole index.
use std::{fs, io::Write, path::Path, time::Instant};
use anyhow::{Result, ensure};
use fastembed::{InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel};

mod profiling {
    #[derive(Default)]
    pub struct Profiler;
    impl Profiler { pub fn batch(&self, _size: usize) {} }
}
#[path = "../../src/embedding/pool.rs"]
mod pool;

fn model(snapshot: &Path, threads: usize) -> Result<TextEmbedding> {
    let files = TokenizerFiles {
        tokenizer_file: fs::read(snapshot.join("tokenizer.json"))?,
        config_file: fs::read(snapshot.join("config.json"))?,
        special_tokens_map_file: fs::read(snapshot.join("special_tokens_map.json"))?,
        tokenizer_config_file: fs::read(snapshot.join("tokenizer_config.json"))?,
    };
    Ok(TextEmbedding::try_new_from_user_defined(
        UserDefinedEmbeddingModel::new(fs::read(snapshot.join("model.onnx"))?, files).with_pooling(Pooling::Mean),
        InitOptionsUserDefined::new().with_max_length(512).with_intra_threads(threads),
    )?)
}

fn main() -> Result<()> {
    tokenizers::utils::parallelism::set_parallelism(false);
    let args: Vec<_> = std::env::args().collect();
    let snapshot = Path::new(&args[1]);
    let batches: Vec<Vec<String>> = serde_json::from_slice(&fs::read(&args[2])?)?;
    let mode = args[3].as_str();
    let batch_size: usize = args[4].parse()?;
    let cpu_budget: usize = args[6].parse()?;
    ensure!(cpu_budget > 0 && batch_size > 0);
    let parallel = matches!(mode, "per-file" | "global-single");
    ensure!(parallel || matches!(mode, "bulk" | "sorted"), "unknown mode");
    let start = Instant::now();
    let mut models = (0..if parallel { cpu_budget } else { 1 })
        .map(|_| model(snapshot, if parallel { 1 } else { cpu_budget }))
        .collect::<Result<Vec<_>>>()?;
    let startup_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let texts: Vec<_> = batches.iter().flatten().cloned().collect();
    let mut order: Vec<_> = (0..texts.len()).collect();
    if mode == "sorted" {
        let lengths = texts.iter().map(|text| models[0].tokenizer.encode(text.as_str(), true).map(|e| e.len()).map_err(|e| anyhow::anyhow!(e))).collect::<Result<Vec<_>>>()?;
        order.sort_by_key(|&i| lengths[i]);
    }
    let ordered: Vec<_> = order.iter().map(|&i| texts[i].clone()).collect();
    let planning_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let profile = profiling::Profiler;
    let operation = |m: &mut TextEmbedding, text: &str| -> Result<Vec<f32>> {
        let mut vectors = m.embed([text], Some(1))?;
        ensure!(vectors.len() == 1);
        Ok(vectors.remove(0))
    };
    let vectors = match mode {
        "per-file" => {
            let mut vectors = Vec::new();
            for batch in &batches { vectors.extend(pool::embed(&mut models, batch, &profile, operation)?); }
            vectors
        }
        "global-single" => pool::embed(&mut models, &texts, &profile, operation)?,
        _ => models[0].embed(&ordered, Some(batch_size))?,
    };
    let embedding_seconds = start.elapsed().as_secs_f64();
    ensure!(vectors.len() == texts.len());
    let mut restored = vec![Vec::new(); vectors.len()];
    for (index, vector) in vectors.into_iter().enumerate() {
        ensure!(vector.len() == 384 && vector.iter().all(|v| v.is_finite()));
        restored[order[index]] = vector;
    }
    let mut output = fs::File::create(&args[5])?;
    for vector in &restored { for x in vector { output.write_all(&x.to_le_bytes())?; } }
    // Diagnostic token counts are outside the embedding and planning timers.
    let lengths = ordered.iter().map(|s| models[0].tokenizer.encode(s.as_str(), true).unwrap().len()).collect::<Vec<_>>();
    let tokens: usize = lengths.iter().sum();
    let padded_tokens: usize = if parallel { tokens } else { lengths.chunks(batch_size).map(|b| b.iter().max().unwrap() * b.len()).sum() };
    println!("{}", serde_json::json!({"mode":mode,"batch_size":if parallel {1} else {batch_size},"cpu_budget":cpu_budget,"startup_seconds":startup_seconds,"planning_seconds":planning_seconds,"embedding_seconds":embedding_seconds,"work_seconds":planning_seconds+embedding_seconds,"documents":texts.len(),"tokens":tokens,"padded_tokens":padded_tokens,"file_batch_barriers":if mode=="per-file" {batches.len()} else {0}}));
    Ok(())
}
