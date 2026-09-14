use crate::status::{bounded, now, utc};
use anyhow::Result;
use clap::Args;
use std::path::{Path, PathBuf};
#[derive(Args)]
pub struct Options {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long)]
    json: bool,
    /// Explicitly validate existing watch views. May read source/history; loads no model.
    #[arg(long)]
    validate: bool,
}
pub(crate) fn read(root: &Path, time: u64) -> serde_json::Value {
    let root = root.canonicalize().unwrap_or_else(|_| root.into());
    let mut value = crate::status::read(&root, time);
    value["components"]["relationships"] =
        crate::index::graph::observation(&root, &value["components"]["relationships"]);
    value["components"]["knowledge"] =
        crate::knowledge::settings::observation(&root, &value["components"]["knowledge"]);
    value["components"]["knowledge"]["at"] = time.into();
    value["components"]["knowledge"]["consumption"] =
        match crate::config::knowledge_mode(&root, None) {
            Ok(crate::config::KnowledgeMode::Off) => "off",
            Ok(crate::config::KnowledgeMode::Auto) => "auto",
            Err(_) => "unavailable",
        }
        .into();
    value
}
pub fn run(options: Options) -> Result<()> {
    let mut value = read(&options.root, now());
    if options.validate {
        value["validation"] = crate::watch::diagnostics(&crate::watch::Options {
            root: options.root.canonicalize()?,
            ..Default::default()
        });
    }
    if options.json {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    println!(
        "Mimirs: {}\nCheckout: {}\nUpdated: {}\nSnapshot: {} ({})",
        env!("CARGO_PKG_VERSION"),
        bounded(value["checkout"].as_str().unwrap_or("."), 1024),
        value["updated_utc"].as_str().unwrap(),
        value["snapshot_path"].as_str().unwrap(),
        value["snapshot"].as_str().unwrap()
    );
    if let Some(error) = value["diagnostic"].as_str() {
        println!("Status diagnostic: {error}");
    }
    for activity in value["activities"].as_object().unwrap().values() {
        println!(
            "{}: {} [{}; heartbeat {} ms ago]",
            activity["phase"].as_str().unwrap(),
            activity["file"].as_str().unwrap_or("."),
            activity["state"].as_str().unwrap(),
            activity["heartbeat_age_ms"]
        );
    }
    for (label, key) in [
        ("Last indexed", "last_indexed"),
        ("Last learned", "last_learned"),
        ("Last success", "last_success"),
        ("Last failure", "last_failure"),
    ] {
        let event = &value[key];
        if event.is_null() {
            continue;
        }
        println!(
            "{label}: {} {} {} at {}",
            event["operation"].as_str().unwrap_or(""),
            event["file"]
                .as_str()
                .or(event["claim"].as_str())
                .unwrap_or(""),
            event["preview"].as_str().unwrap_or(""),
            utc(event["at"].as_u64().unwrap_or(0))
        );
    }
    for (component, observation) in value["components"].as_object().unwrap() {
        println!(
            "{component}: {} (observed {}) - {}",
            observation["status"].as_str().unwrap(),
            utc(observation["at"].as_u64().unwrap()),
            observation["basis"].as_str().unwrap()
        );
        if !observation["target"].is_null() {
            println!("Target: {}", observation["target"]);
        }
    }
    for failure in value["failures"].as_array().unwrap() {
        println!(
            "Historical failure at {}: {} [{}] {}: {}",
            utc(failure["at"].as_u64().unwrap_or(0)),
            failure["operation"].as_str().unwrap(),
            failure["component"].as_str().unwrap(),
            failure["file"]
                .as_str()
                .or(failure["claim"].as_str())
                .unwrap_or("."),
            failure["reason"].as_str().unwrap_or("operation failed")
        );
    }
    println!(
        "Omitted activity entries: {}; older failures: {}",
        value["omitted_activities"], value["omitted_failures"]
    );
    println!(
        "Recorded success is historical. Use --validate for explicit watch-view checks. Share mimirs status --json after reviewing local paths and previews."
    );
    if options.validate {
        println!("Validation: {}", value["validation"]);
    }
    Ok(())
}
