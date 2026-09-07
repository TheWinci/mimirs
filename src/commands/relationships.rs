use crate::{analysis, config::Config, source};
use analysis::relationships::{self, Options, Relationships};
use anyhow::{Context, ensure};
use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
};

/// Analyze the selected project files without an index or embedding model.
pub fn run(json: bool) -> anyhow::Result<()> {
    let root = std::env::current_dir().context("cannot find current directory")?;
    let result = analyze(&root)?;
    let output = if json {
        serde_json::to_string_pretty(&result)?
    } else {
        relationships::render(&root.display().to_string(), &result)
    };
    writeln!(io::stdout().lock(), "{output}")?;
    Ok(())
}

fn analyze(root: &Path) -> anyhow::Result<Relationships> {
    let mut config = if root.join(".mimirs/config.toml").try_exists()? {
        Config::load(root)?
    } else {
        Config::default()
    };
    let sources = super::index::walk::discover(root, &config, |_, _| Ok(()))?;
    ensure!(
        sources.errors.is_empty(),
        "source discovery failed: {}",
        sources.errors.join("; ")
    );
    let analyses = sources
        .paths
        .iter()
        .map(|path| {
            analysis::extract(source::read(root, path)?)
                .with_context(|| format!("cannot analyze {path}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    // Asset references need existence, never binary contents. Keep exclusions and gitignore.
    config.include = vec!["**/*".into()];
    let assets = super::index::walk::discover(root, &config, |_, _| Ok(()))?;
    ensure!(
        assets.errors.is_empty(),
        "asset discovery failed: {}",
        assets.errors.join("; ")
    );
    let project_paths: HashSet<_> = assets.paths.into_iter().chain(sources.paths).collect();
    let go_module_path = if project_paths.contains("go.mod") {
        relationships::parse_go_module(&source::read(root, "go.mod")?.text)
    } else {
        None
    };
    Ok(relationships::connect(
        &analyses,
        &Options {
            go_module_path,
            project_paths: Some(project_paths),
        },
    ))
}

#[cfg(test)]
#[path = "../../tests/unit/commands/relationships.rs"]
mod tests;
