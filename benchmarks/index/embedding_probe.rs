//! Standalone experiment, built by probe.py; not part of the mimirs CLI.
use std::{fs, io::Write, path::Path, time::Instant};
use fastembed::{InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let snapshot = Path::new(&args[1]);
    let batches: Vec<Vec<String>> = serde_json::from_slice(&fs::read(&args[2])?)?;
    let threads: usize = args[3].parse()?;
    let start = Instant::now();
    let files = TokenizerFiles {
        tokenizer_file: fs::read(snapshot.join("tokenizer.json"))?,
        config_file: fs::read(snapshot.join("config.json"))?,
        special_tokens_map_file: fs::read(snapshot.join("special_tokens_map.json"))?,
        tokenizer_config_file: fs::read(snapshot.join("tokenizer_config.json"))?,
    };
    let model = UserDefinedEmbeddingModel::new(fs::read(snapshot.join("model.onnx"))?, files).with_pooling(Pooling::Mean);
    let mut options = InitOptionsUserDefined::new().with_max_length(512);
    if threads > 0 { options = options.with_intra_threads(threads); }
    let mut embedder = TextEmbedding::try_new_from_user_defined(model, options)?;
    let startup_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let mut vectors = Vec::new();
    for batch in &batches { vectors.extend(embedder.embed(batch, None)?); }
    let embedding_seconds = start.elapsed().as_secs_f64();
    let mut output = fs::File::create(&args[4])?;
    for vector in &vectors { for x in vector { output.write_all(&x.to_le_bytes())?; } }
    // Padding estimate is deliberately outside the timed embedding work.
    let mut tokens = 0;
    let mut padded_tokens = 0;
    for batch in &batches {
        let lengths: Vec<_> = batch.iter().map(|s| embedder.tokenizer.encode(s.as_str(), true).unwrap().len()).collect();
        tokens += lengths.iter().sum::<usize>();
        padded_tokens += lengths.iter().max().copied().unwrap_or(0) * batch.len();
    }
    println!("{}", serde_json::json!({"threads":threads,"startup_seconds":startup_seconds,"embedding_seconds":embedding_seconds,"calls":batches.len(),"documents":vectors.len(),"tokens":tokens,"batch_padded_tokens":padded_tokens}));
    Ok(())
}
