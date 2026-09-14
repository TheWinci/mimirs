use crate::{
    config::Config, files::fingerprint, source::SourceFile, source::observation, source::walk,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use crate::files::{Stamp, stamp};
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Content {
    #[default]
    Text,
    UnsupportedEncoding,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub stamp: Option<Stamp>,
    #[serde(default)]
    pub content: Content,
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
        Self::capture_profiled(
            root,
            force,
            previous,
            &crate::profiling::Profiler::default(),
        )
    }
    pub fn capture_profiled(
        root: &Path,
        force: bool,
        previous: Option<&Self>,
        profile: &crate::profiling::Profiler,
    ) -> Result<(Self, usize)> {
        Self::capture_progress(root, force, previous, profile, &mut |_, _, _| Ok(()))
    }
    pub(crate) fn capture_progress(
        root: &Path,
        force: bool,
        previous: Option<&Self>,
        profile: &crate::profiling::Profiler,
        progress: &mut impl FnMut(&str, &str, usize) -> std::io::Result<()>,
    ) -> Result<(Self, usize)> {
        let config = profile.measure("config", || Config::load(root))?;
        let sources = walk::discover(root, &config.selection(), |path, found| {
            progress("discovering source", path, found)
        })?;
        let canonical_config = config.to_toml()?;
        let mut asset_config = config;
        asset_config.include = vec!["**/*".into()];
        let assets = walk::discover(root, &asset_config.selection(), |path, found| {
            progress("discovering resolver inputs", path, found)
        })?;
        let mut errors = sources.errors;
        errors.extend(assets.errors);
        let mut reads = 0;
        let mut files = BTreeMap::new();
        for (observed, path) in sources.paths.into_iter().enumerate() {
            progress("observing source", &path, observed + 1)?;
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
                        content: if std::str::from_utf8(&bytes).is_ok() {
                            Content::Text
                        } else {
                            Content::UnsupportedEncoding
                        },
                        error: None,
                    },
                    Ok(None) => File {
                        stamp: current_stamp,
                        hash: None,
                        content: Content::Text,
                        error: Some("source disappeared during discovery".into()),
                    },
                    Err(e) => File {
                        stamp: current_stamp,
                        hash: None,
                        content: Content::Text,
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
                    .map(|(p, f)| (p, &f.hash, &f.content, &f.error))
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
}

fn read(root: &Path, path: &str) -> Result<SourceFile> {
    let bytes =
        observation::read_bytes(root, path)?.context("source disappeared during reconciliation")?;
    Ok(SourceFile {
        path: path.into(),
        text: String::from_utf8(bytes).context("source is not valid UTF-8")?,
    })
}
