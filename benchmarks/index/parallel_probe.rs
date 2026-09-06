//! Persistent single-chunk workers, with a barrier after each input file batch.
use fastembed::{
    InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};
use std::{fs, io::Write, path::Path, sync::mpsc, thread, time::Instant};

fn model(snapshot: &Path, threads: usize) -> TextEmbedding {
    let files = TokenizerFiles {
        tokenizer_file: fs::read(snapshot.join("tokenizer.json")).unwrap(),
        config_file: fs::read(snapshot.join("config.json")).unwrap(),
        special_tokens_map_file: fs::read(snapshot.join("special_tokens_map.json")).unwrap(),
        tokenizer_config_file: fs::read(snapshot.join("tokenizer_config.json")).unwrap(),
    };
    let model =
        UserDefinedEmbeddingModel::new(fs::read(snapshot.join("model.onnx")).unwrap(), files)
            .with_pooling(Pooling::Mean);
    TextEmbedding::try_new_from_user_defined(
        model,
        InitOptionsUserDefined::new()
            .with_max_length(512)
            .with_intra_threads(threads),
    )
    .unwrap()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let batches: Vec<Vec<String>> = serde_json::from_slice(&fs::read(&args[2])?)?;
    let threads: usize = args[3].parse()?;
    let workers: usize = args[5].parse()?;
    assert!(workers > 0 && threads > 0);
    let start = Instant::now();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let mut queues = Vec::new();
    let mut handles = Vec::new();
    for _ in 0..workers {
        let (job_tx, job_rx) = mpsc::channel::<(usize, String)>();
        queues.push(job_tx);
        let ready_tx = ready_tx.clone();
        let result_tx = result_tx.clone();
        let snapshot = args[1].clone();
        handles.push(thread::spawn(move || {
            let mut embedder = model(Path::new(&snapshot), threads);
            ready_tx.send(()).unwrap();
            for (ordinal, text) in job_rx {
                let mut vectors = embedder.embed(vec![text], Some(1)).unwrap();
                result_tx.send((ordinal, vectors.pop().unwrap())).unwrap();
            }
        }));
    }
    drop(ready_tx);
    drop(result_tx);
    for _ in 0..workers {
        ready_rx.recv()?;
    }
    let startup_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let mut vectors = Vec::new();
    for batch in &batches {
        // At most one job per worker is in flight. Assign the next chunk to the
        // worker that finishes first; never dispatch work from the next file.
        let mut pending = batch.iter().enumerate();
        let mut active = std::collections::HashMap::new();
        for (worker, queue) in queues.iter().enumerate() {
            if let Some((ordinal, text)) = pending.next() {
                queue.send((ordinal, text.clone()))?;
                active.insert(ordinal, worker);
            }
        }
        let mut ordered = vec![Vec::new(); batch.len()];
        for _ in 0..batch.len() {
            let (ordinal, vector) = result_rx.recv()?;
            ordered[ordinal] = vector;
            let worker = active.remove(&ordinal).unwrap();
            if let Some((ordinal, text)) = pending.next() {
                queues[worker].send((ordinal, text.clone()))?;
                active.insert(ordinal, worker);
            }
        }
        vectors.extend(ordered);
    }
    let embedding_seconds = start.elapsed().as_secs_f64();
    drop(queues);
    for handle in handles {
        handle.join().unwrap();
    }
    let mut output = fs::File::create(&args[4])?;
    for vector in &vectors {
        for x in vector {
            output.write_all(&x.to_le_bytes())?;
        }
    }
    println!(
        "{}",
        serde_json::json!({"workers": workers, "threads_per_worker": threads, "startup_seconds": startup_seconds, "embedding_seconds": embedding_seconds, "calls": vectors.len(), "documents": vectors.len(), "file_batch_barriers": batches.len()})
    );
    Ok(())
}
