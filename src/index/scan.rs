use crate::{
    config::Config, files::fingerprint, source::SourceFile, source::observation, source::walk,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use crate::files::{Stamp, stamp};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub stamp: Option<Stamp>,
    pub hash: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scan {
    pub files: BTreeMap<String, File>,
    pub assets: BTreeSet<String>,
    pub config: String,
    pub go_module: Option<String>,
    pub head: Option<String>,
    pub errors: Vec<String>,
}
impl Scan {
    pub fn capture(root: &Path, force: bool, previous: Option<&Self>) -> Result<(Self, usize)> {
        let config = Config::load(root)?;
        let sources = walk::discover(root, &config.selection(), |_, _| Ok(()))?;
        let canonical_config = config.to_toml()?;
        let mut asset_config = config;
        asset_config.include = vec!["**/*".into()];
        let assets = walk::discover(root, &asset_config.selection(), |_, _| Ok(()))?;
        let mut errors = sources.errors;
        errors.extend(assets.errors);
        let mut reads = 0;
        let mut files = BTreeMap::new();
        for path in sources.paths {
            let current_stamp = stamp(&root.join(&path)).ok();
            let old = previous.and_then(|s| s.files.get(&path));
            let file = if !force
                && current_stamp.is_some()
                && old.is_some_and(|f| f.stamp == current_stamp && f.error.is_none())
            {
                old.unwrap().clone()
            } else {
                reads += 1;
                match observation::read_bytes(root, &path) {
                    Ok(Some(bytes)) => File {
                        stamp: current_stamp,
                        hash: Some(fingerprint(&bytes)),
                        error: std::str::from_utf8(&bytes)
                            .err()
                            .map(|_| "source is not valid UTF-8".into()),
                    },
                    Ok(None) => File {
                        stamp: current_stamp,
                        hash: None,
                        error: Some("source disappeared during discovery".into()),
                    },
                    Err(e) => File {
                        stamp: current_stamp,
                        hash: None,
                        error: Some(format!("{e:#}")),
                    },
                }
            };
            files.insert(path, file);
        }
        let assets: BTreeSet<_> = assets
            .paths
            .into_iter()
            .chain(files.keys().cloned())
            .collect();
        let go_module = if assets.contains("go.mod") {
            Some(read(root, "go.mod")?.text)
        } else {
            None
        };
        let head = crate::git::command(root)?
            .args(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        Ok((
            Self {
                files,
                assets,
                config: canonical_config,
                go_module,
                head,
                errors,
            },
            reads,
        ))
    }
    pub fn key(&self) -> String {
        fingerprint(
            &serde_json::to_vec(&(
                self.files
                    .iter()
                    .map(|(p, f)| (p, &f.hash, &f.error))
                    .collect::<Vec<_>>(),
                &self.assets,
                &self.config,
                &self.go_module,
                &self.head,
                &self.errors,
            ))
            .unwrap(),
        )
    }
    pub fn source(&self, root: &Path, path: &str) -> Result<SourceFile> {
        let source = read(root, path)?;
        ensure!(
            self.files[path].hash.as_deref() == Some(fingerprint(source.text.as_bytes()).as_str()),
            "source changed during reconciliation: {path}"
        );
        Ok(source)
    }
}

fn read(root: &Path, path: &str) -> Result<SourceFile> {
    let bytes =
        observation::read_bytes(root, path)?.context("source disappeared during reconciliation")?;
    Ok(SourceFile {
        path: path.into(),
        text: String::from_utf8(bytes).context("source is not valid UTF-8")?,
    })
}
