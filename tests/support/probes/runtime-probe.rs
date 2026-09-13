//! Opt-in experiment inside the test binary. No production settings are changed.
use super::{Model, pool};
use anyhow::{Context, Result, ensure};
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

#[derive(Deserialize)]
struct Config {
    action: String,
    root: PathBuf,
    projects: Option<PathBuf>,
    per_corpus: Option<usize>,
    sessions: Option<usize>,
    threads: Option<usize>,
    batch: Option<usize>,
    label: Option<String>,
    profile: Option<bool>,
    limit: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Input {
    corpus: String,
    path: String,
    document: usize,
    window: usize,
    text: String,
    ids: Vec<i64>,
    mask: Vec<i64>,
    types: Vec<i64>,
}

fn asset(name: &str) -> Result<PathBuf> {
    let cache = hf_hub::Cache::new(crate::embedding::model_cache_dir()?);
    let repo = hf_hub::Repo::with_revision(
        crate::embedding::MODEL_REPOSITORY.into(),
        hf_hub::RepoType::Model,
        crate::embedding::MODEL_REVISION.into(),
    );
    cache
        .repo(repo)
        .get(name)
        .context("pinned model asset must already be cached")
}

fn write_vectors(path: &Path, vectors: &[Vec<f32>]) -> Result<()> {
    let mut file = std::io::BufWriter::new(fs::File::create(path)?);
    for vector in vectors {
        ensure!(
            vector.len() == 384 && vector.iter().all(|v| v.is_finite()),
            "invalid vector"
        );
        for value in vector {
            file.write_all(&value.to_le_bytes())?;
        }
    }
    Ok(())
}

fn capture(config: &Config) -> Result<serde_json::Value> {
    let weights = fs::read(asset("onnx/model_quantized.onnx")?)?;
    let tokenizer = fs::read(asset("tokenizer.json")?)?;
    let mut model = Model::new(&weights, &tokenizer)?;
    let planner = crate::embedding::ts_v2::unbounded(model.tokenizer.clone())?;
    let mut selected = Vec::new();
    let mut manifests = Vec::new();
    let count = config.per_corpus.unwrap_or(128);
    ensure!(count > 0, "empty sample");
    for corpus in ["mimirs", "excalidraw", "django"] {
        let db_path = config
            .projects
            .as_ref()
            .context("projects required")?
            .join(corpus)
            .join(".mimirs/index.db");
        let db = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut query = db.prepare("SELECT f.path,d.ordinal,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal")?;
        let rows = query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut group = (String::new(), usize::MAX);
        let mut seen = HashSet::new();
        let mut inputs = Vec::new();
        for row in rows {
            let (path, document, text) = row?;
            let document = usize::try_from(document)?;
            let next_group = (path.clone(), document / 1024);
            if group != next_group {
                group = next_group;
                seen.clear();
            }
            for (window, text) in crate::embedding::ts_v2::document_inputs(&planner, &text)?
                .into_iter()
                .enumerate()
            {
                if !seen.insert(text.clone()) {
                    continue;
                }
                let encoding = model
                    .tokenizer
                    .encode_batch(vec![text.as_str()], true)
                    .map_err(anyhow::Error::msg)?
                    .remove(0);
                inputs.push(Input {
                    corpus: corpus.into(),
                    path: path.clone(),
                    document,
                    window,
                    text,
                    ids: encoding.get_ids().iter().map(|&v| v as i64).collect(),
                    mask: encoding
                        .get_attention_mask()
                        .iter()
                        .map(|&v| v as i64)
                        .collect(),
                    types: encoding.get_type_ids().iter().map(|&v| v as i64).collect(),
                });
            }
        }
        // Systematic quantiles preserve the observed length distribution and
        // include short and long real inputs. Each corpus has equal representation.
        inputs.sort_by_key(|v| v.ids.len());
        ensure!(inputs.len() >= count, "sample exceeds corpus");
        manifests.push(serde_json::json!({"corpus":corpus,"population":inputs.len(),"sample":count,
            "min_tokens":inputs.first().unwrap().ids.len(),"max_tokens":inputs.last().unwrap().ids.len(),
            "population_tokens":inputs.iter().map(|i|i.ids.len()).sum::<usize>()}));
        for i in 0..count {
            selected.push(inputs[(2 * i + 1) * inputs.len() / (2 * count)].clone());
        }
        println!(
            "CAPTURED {corpus}: {} windows, {count} selected",
            inputs.len()
        );
    }
    fs::write(
        config.root.join("inputs.json"),
        serde_json::to_vec(&selected)?,
    )?;
    // Reference uses the actual production Model path, including its tokenizer,
    // tensor construction, singleton execution, and pooling.
    let mut vectors = Vec::new();
    for input in &selected {
        vectors.push(model.embed(&[&input.text])?.remove(0));
    }
    write_vectors(&config.root.join("reference.bin"), &vectors)?;
    Ok(
        serde_json::json!({"corpora":manifests,"windows":selected.len(),"model_path":asset("onnx/model_quantized.onnx")?,
        "tokenizer_path":asset("tokenizer.json")?,"model":crate::embedding::model_identity()}),
    )
}

struct Batch {
    ordinals: Vec<usize>,
    length: usize,
    mask_values: Vec<i64>,
    ids: Tensor<i64>,
    mask: Tensor<i64>,
    types: Tensor<i64>,
}

fn batches(inputs: &[Input], size: usize) -> Result<Vec<Batch>> {
    ensure!(size > 0 && !inputs.is_empty(), "empty batch input");
    ensure!(
        inputs.iter().all(|i| !i.ids.is_empty()
            && i.ids.len() == i.mask.len()
            && i.ids.len() == i.types.len()),
        "inconsistent input tensor lengths"
    );
    let mut order = (0..inputs.len()).collect::<Vec<_>>();
    order.sort_by_key(|&i| (inputs[i].ids.len(), i));
    order
        .chunks(size)
        .map(|ordinals| {
            let length = ordinals.iter().map(|&i| inputs[i].ids.len()).max().unwrap();
            let shape = [ordinals.len(), length];
            let mut ids = vec![0; shape[0] * shape[1]];
            let mut mask = ids.clone();
            let mut types = ids.clone();
            for (row, &i) in ordinals.iter().enumerate() {
                let input = &inputs[i];
                let range = row * length..row * length + input.ids.len();
                ids[range.clone()].copy_from_slice(&input.ids);
                mask[range.clone()].copy_from_slice(&input.mask);
                types[range].copy_from_slice(&input.types);
            }
            Ok(Batch {
                ordinals: ordinals.to_vec(),
                length,
                mask_values: mask.clone(),
                ids: Tensor::from_array((shape, ids))?,
                mask: Tensor::from_array((shape, mask))?,
                types: Tensor::from_array((shape, types))?,
            })
        })
        .collect()
}

fn call(session: &mut Session, batch: &Batch) -> Result<(f64, Vec<Vec<f32>>)> {
    let inputs = ort::inputs!["input_ids"=>&batch.ids,"attention_mask"=>&batch.mask,"token_type_ids"=>&batch.types];
    let start = Instant::now();
    let outputs = session.run(inputs)?;
    let runtime_seconds = start.elapsed().as_secs_f64();
    let (shape, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
    ensure!(
        shape.as_ref() == [batch.ordinals.len() as i64, batch.length as i64, 384],
        "bad model output shape"
    );
    let vectors = hidden
        .chunks_exact(batch.length * 384)
        .zip(batch.mask_values.chunks_exact(batch.length))
        .map(|(hidden, mask)| pool(hidden, mask))
        .collect::<Result<Vec<_>>>()?;
    Ok((runtime_seconds, vectors))
}

fn replay(config: &Config) -> Result<serde_json::Value> {
    let mut inputs: Vec<Input> =
        serde_json::from_slice(&fs::read(config.root.join("inputs.json"))?)?;
    if let Some(limit) = config.limit {
        ensure!(
            limit > 0 && limit <= inputs.len(),
            "invalid profile sample limit"
        );
        inputs = (0..limit)
            .map(|i| inputs[(2 * i + 1) * inputs.len() / (2 * limit)].clone())
            .collect();
    }
    let sessions = config.sessions.context("sessions required")?;
    let threads = config.threads.context("threads required")?;
    let batch_size = config.batch.context("batch required")?;
    ensure!(
        sessions > 0 && threads > 0 && batch_size > 0,
        "zero worker or batch setting"
    );
    let batches = batches(&inputs, batch_size)?;
    let profiled = config.profile.unwrap_or(false);
    let label = config.label.as_ref().context("label required")?;
    let weights = fs::read(asset("onnx/model_quantized.onnx")?)?;
    let startup = Instant::now();
    let mut models = Vec::new();
    for worker in 0..sessions {
        let mut builder = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?;
        if profiled {
            builder =
                builder.with_profiling(config.root.join(format!("{label}-worker-{worker}")))?;
        }
        models.push(builder.commit_from_memory(&weights)?);
    }
    let startup_seconds = startup.elapsed().as_secs_f64();
    if !profiled {
        // Session warmup is outside timing. Both ends of the shape range are used.
        for model in &mut models {
            call(model, &batches[0])?;
            call(model, batches.last().unwrap())?;
        }
    }
    let barrier = Barrier::new(sessions + 1);
    let next = AtomicUsize::new(0);
    let (wall_seconds, records, traces) = std::thread::scope(|scope| -> Result<_> {
        let mut handles = Vec::new();
        for mut model in models {
            let (barrier, next, batches) = (&barrier, &next, &batches);
            handles.push(scope.spawn(move || -> Result<_> {
                let mut records = Vec::new();
                barrier.wait();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= batches.len() {
                        break;
                    }
                    let (seconds, vectors) = call(&mut model, &batches[i])?;
                    records.push((i, seconds, vectors));
                }
                // Keep session teardown and profiler flushing outside replay time.
                Ok((model, records))
            }));
        }
        let start = Instant::now();
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|h| h.join().expect("runtime worker panic"))
            .collect::<Result<Vec<_>>>()?;
        let wall_seconds = start.elapsed().as_secs_f64();
        let mut records = Vec::new();
        let mut traces = Vec::new();
        for (mut model, worker_records) in results {
            records.extend(worker_records);
            if profiled {
                traces.push(model.end_profiling()?);
            }
        }
        Ok((wall_seconds, records, traces))
    })?;
    ensure!(records.len() == batches.len(), "missing completed batches");
    let mut vectors = vec![Vec::new(); inputs.len()];
    let mut latencies = Vec::new();
    for (i, seconds, values) in records {
        latencies.push(seconds);
        ensure!(
            values.len() == batches[i].ordinals.len(),
            "missing output windows"
        );
        for (&ordinal, value) in batches[i].ordinals.iter().zip(values) {
            vectors[ordinal] = value;
        }
    }
    write_vectors(&config.root.join(format!("{label}.bin")), &vectors)?;
    latencies.sort_by(f64::total_cmp);
    let sum = latencies.iter().sum::<f64>();
    Ok(
        serde_json::json!({"sessions":sessions,"intra_threads":threads,"inter_threads":1,"batch":batch_size,
        "windows":inputs.len(),"calls":latencies.len(),"replay_wall_seconds":wall_seconds,
        "windows_per_second":inputs.len() as f64/wall_seconds,"runtime_seconds":sum,
        "mean_call_seconds":sum/latencies.len() as f64,"p95_call_seconds":latencies[(latencies.len()*95).div_ceil(100)-1],
        "max_call_seconds":latencies.last(),"startup_seconds":startup_seconds,"profiled":profiled,"traces":traces,
        "tokens":inputs.iter().map(|i|i.ids.len()).sum::<usize>(),
        "padded_tokens":batches.iter().map(|b|b.length*b.ordinals.len()).sum::<usize>()}),
    )
}

#[test]
#[ignore = "opt-in ONNX runtime experiment; requires MIMIRS_RUNTIME_PROBE_CONFIG"]
fn onnx_runtime_experiment() -> Result<()> {
    tokenizers::utils::parallelism::set_parallelism(false);
    let config: Config =
        serde_json::from_slice(&fs::read(std::env::var("MIMIRS_RUNTIME_PROBE_CONFIG")?)?)?;
    let report = if config.action == "capture" {
        capture(&config)?
    } else {
        ensure!(config.action == "replay", "unknown experiment action");
        replay(&config)?
    };
    println!("RUNTIME_REPORT={}", serde_json::to_string(&report)?);
    Ok(())
}

#[test]
fn batch_padding_preserves_token_rows_masks_and_output_positions() -> Result<()> {
    let inputs = [vec![101, 10, 11, 102], vec![101, 102], vec![101, 12, 102]]
        .into_iter()
        .map(|ids| Input {
            corpus: String::new(),
            path: String::new(),
            document: 0,
            window: 0,
            text: String::new(),
            mask: vec![1; ids.len()],
            types: vec![0; ids.len()],
            ids,
        })
        .collect::<Vec<_>>();
    let grouped = batches(&inputs, 2)?;
    assert_eq!(grouped.len(), 2);
    assert_eq!(grouped[0].ordinals, [1, 2]);
    assert_eq!(
        grouped[0].ids.try_extract_tensor::<i64>()?.1,
        &[101, 102, 0, 101, 12, 102]
    );
    assert_eq!(
        grouped[0].mask.try_extract_tensor::<i64>()?.1,
        &[1, 1, 0, 1, 1, 1]
    );
    assert_eq!(grouped[1].ordinals, [0]);
    assert_eq!(
        grouped[1].ids.try_extract_tensor::<i64>()?.1,
        &[101, 10, 11, 102]
    );
    assert!(batches(&inputs, 0).is_err());
    assert!(batches(&[], 1).is_err());
    Ok(())
}
