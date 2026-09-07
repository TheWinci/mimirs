use crate::{analysis, source, storage};
use anyhow::{Context, ensure};
use std::{
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

pub fn run(file: &Path, stored: bool, source_chunks: bool) -> anyhow::Result<()> {
    let root = std::env::current_dir().context("cannot find current directory")?;
    let report = if source_chunks {
        let analysis = load_at(&root, file, stored)?;
        serde_json::to_string_pretty(&crate::retrieval::ts_v2::preview(&analysis)?)?
    } else {
        report_at(&root, file, stored)?
    };
    io::stdout().lock().write_all(report.as_bytes())?;
    Ok(())
}

fn report_at(root: &Path, file: &Path, stored: bool) -> anyhow::Result<String> {
    let analysis = load_at(root, file, stored)?;
    let projection = crate::retrieval::project(&analysis)?;
    let mut report = analysis::report(projection.analysis);
    for relation in &projection.relations {
        report.push_str(&format!(
            "relation: {:?} {:?} {:?} bytes {}..{}\n",
            relation.from,
            relation.kind,
            relation.target,
            relation.evidence.start,
            relation.evidence.end
        ));
    }
    Ok(report)
}

fn load_at(root: &Path, file: &Path, stored: bool) -> anyhow::Result<analysis::Analysis> {
    let full = normalize(&root.join(file));
    let relative = full.strip_prefix(root);
    ensure!(
        !stored || relative.is_ok(),
        "stored source path is outside the project: {}",
        file.display()
    );
    let path = relative
        .unwrap_or(&full)
        .to_str()
        .with_context(|| format!("source path is not UTF-8: {}", file.display()))?;
    let analysis = if stored {
        let connection = storage::open_read_only(&root.join(".mimirs/index.db"))?;
        let transaction = connection.unchecked_transaction()?;
        storage::analysis::load(&transaction, path)
            .with_context(|| format!("cannot inspect stored source {path}"))?
            .with_context(|| format!("no stored source analysis for {path}; run mimirs index"))?
    } else {
        analysis::extract(source::read(root, path)?)
            .with_context(|| format!("cannot analyze {}", file.display()))?
    };
    Ok(analysis)
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

#[cfg(test)]
#[path = "../../tests/unit/commands/inspect.rs"]
mod tests;
