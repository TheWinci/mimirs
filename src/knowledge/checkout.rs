use super::{fingerprint, model::*};
use crate::source::observation::read_bytes;
pub use crate::source::observation::{Observation, Observed};
use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};

pub struct Checkout {
    pub root: PathBuf,
    pub revision: Revision,
    pub branch: Option<String>,
    pub default_branch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Ancestry {
    Ancestor,
    NotAncestor,
    Unavailable,
}
impl Checkout {
    pub fn open(root: &Path, repository: &RepositoryId) -> Result<Self> {
        let root = root.canonicalize().context("cannot open repository root")?;
        let top = git(&root, &["rev-parse", "--show-toplevel"])?;
        ensure!(
            Path::new(top.trim()).canonicalize()? == root,
            "--root must be the Git repository root"
        );
        let revision = Revision {
            repository: repository.clone(),
            commit: git(&root, &["rev-parse", "--verify", "HEAD^{commit}"])?
                .trim()
                .into(),
        };
        revision.validate(repository)?;
        let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        let branch = (branch.trim() != "HEAD").then(|| branch.trim().to_owned());
        Ok(Self {
            root,
            revision,
            branch,
            default_branch: super::model::default_branch(),
        })
    }
    pub fn with_default_branch(mut self, branch: &str) -> Result<Self> {
        let valid = crate::git::command(&self.root)?
            .args(["check-ref-format", &format!("refs/heads/{branch}")])
            .output()?;
        ensure!(
            !branch.trim().is_empty() && valid.status.success(),
            "invalid default branch name"
        );
        self.default_branch = branch.into();
        Ok(self)
    }
    pub fn cleanliness(&self) -> Result<(bool, Vec<String>)> {
        let blockers = crate::git::cleanliness_blockers(&self.root)?;
        let dirty = !git(
            &self.root,
            &[
                "status",
                "--porcelain",
                "--untracked-files=normal",
                "--",
                ".",
                ":(exclude).mimirs/knowledge",
            ],
        )?
        .trim()
        .is_empty();
        Ok((dirty || !blockers.is_empty(), blockers))
    }
    pub fn dirty(&self) -> Result<bool> {
        Ok(self.cleanliness()?.0)
    }
    pub fn committed_support(&self, evidence: &FileEvidence) -> Result<bool> {
        let Some(bytes) = self.read_bytes(&evidence.path)? else {
            return Ok(false);
        };
        if fingerprint(&bytes) != evidence.sha256 {
            return Ok(false);
        }
        let (committed, identity) = super::conversion::inspect(self, &evidence.path, &bytes)?;
        Ok(committed && (evidence.committed.is_none() || evidence.committed == identity))
    }

    pub fn ensure_head(&self) -> Result<()> {
        ensure!(
            git(&self.root, &["rev-parse", "--verify", "HEAD^{commit}"])?.trim()
                == self.revision.commit,
            "HEAD changed while reading evidence; retry"
        );
        ensure!(
            git(&self.root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim()
                == self.branch.as_deref().unwrap_or("HEAD"),
            "branch changed while reading evidence; retry"
        );
        Ok(())
    }
    pub fn contains(&self, revision: &Revision) -> Result<bool> {
        self.is_ancestor(revision, &self.revision)
    }
    pub fn is_ancestor(&self, revision: &Revision, descendant: &Revision) -> Result<bool> {
        Ok(self.ancestry(revision, descendant)? == Ancestry::Ancestor)
    }
    pub fn ancestry(&self, revision: &Revision, descendant: &Revision) -> Result<Ancestry> {
        revision.validate(&self.revision.repository)?;
        descendant.validate(&self.revision.repository)?;
        let result = crate::git::command(&self.root)?
            .args([
                "merge-base",
                "--is-ancestor",
                &revision.commit,
                &descendant.commit,
            ])
            .output()?;
        if result.status.success() {
            return Ok(Ancestry::Ancestor);
        }
        if result.status.code() != Some(1)
            || git(&self.root, &["rev-parse", "--is-shallow-repository"])?.trim() == "true"
        {
            return Ok(Ancestry::Unavailable);
        }
        Ok(Ancestry::NotAncestor)
    }
    pub fn observe(&self, path: &str) -> Observed {
        Observed::read(&self.root, path)
    }
    pub fn read(&self, path: &str) -> Result<Option<crate::source::SourceFile>> {
        self.read_bytes(path)?
            .map(|bytes| {
                Ok(crate::source::SourceFile {
                    path: path.to_owned(),
                    text: String::from_utf8(bytes)
                        .with_context(|| format!("source file {path} is not valid UTF-8"))?,
                })
            })
            .transpose()
    }

    /// Resolve containment before reading, including for non-UTF-8 observations.
    pub fn read_bytes(&self, path: &str) -> Result<Option<Vec<u8>>> {
        read_bytes(&self.root, path)
    }
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = crate::git::command(root)?
        .args(args)
        .output()
        .context("cannot run Git")?;
    ensure!(
        output.status.success(),
        "Git failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8(output.stdout)?)
}
