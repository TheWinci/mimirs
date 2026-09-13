//! Disposable all-claim maintenance cache. Task context still assesses selected
//! claims live and never enters this module.
use crate::files::cache::{load, persist};
use crate::{
    knowledge::assessment as context,
    knowledge::{self, checkout::Checkout, model::*, projection},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct Options {
    pub root: PathBuf,
    pub repository: Option<String>,
    pub state: Option<PathBuf>,
    pub default_branch: Option<String>,
}

#[derive(Default)]
pub struct Reads {
    pub support: usize,
    pub journal_replays: usize,
}

#[derive(Default)]
pub struct Watcher {
    pub target: Option<crate::status::Target>,
    metadata: Option<String>,
    paths: Vec<String>,
    journal: Option<PathBuf>,
    git: bool,
    cache: Option<crate::files::Stamp>,
}

struct Input {
    journal: Option<PathBuf>,
    key: String,
    checkout: Option<Checkout>,
    claims: BTreeMap<KnowledgeId, projection::Knowledge>,
    observations: BTreeMap<String, crate::source::observation::Observed>,
}
impl Input {
    fn capture(
        options: &Options,
        reads: &mut Reads,
        target: &mut Option<crate::status::Target>,
    ) -> Result<Self> {
        *target = None;
        let settings = knowledge::settings::resolve(
            &options.root,
            options.repository.as_deref(),
            options.default_branch.as_deref(),
            None,
        )?;
        *target = Some(knowledge::settings::diagnostic_target(
            &options.root,
            options.state.as_deref(),
            settings.repository.as_ref(),
            Some(&settings.default_branch),
        ));
        let Some(repository) = settings.repository else {
            return Ok(Self {
                key: "not_configured-v1".into(),
                journal: None,
                checkout: None,
                claims: BTreeMap::new(),
                observations: BTreeMap::new(),
            });
        };
        let checkout = Checkout::open(&options.root, &repository)?
            .with_default_branch(&settings.default_branch)?;
        let state = options
            .state
            .clone()
            .unwrap_or_else(|| options.root.join(".mimirs/knowledge"));
        anyhow::ensure!(
            state
                .join("repositories")
                .join(knowledge::fingerprint(repository.0.as_bytes()))
                .try_exists()?,
            "unknown local knowledge repository; configure or pull it explicitly"
        );
        reads.journal_replays += 1;
        let events = knowledge::read_events(&state, &repository)?;
        let journal = state
            .join("repositories")
            .join(knowledge::fingerprint(repository.0.as_bytes()))
            .join("events");
        let claims = projection::reduce(&events)?;
        let mut paths = BTreeSet::new();
        for claim in claims.values() {
            let active = knowledge::reviews::active(&checkout, claim)?;
            let heads = if active.heads.is_empty() {
                knowledge::reviews::states(claim)?
                    .into_iter()
                    .take(1)
                    .collect()
            } else {
                active.heads
            };
            paths.extend(
                heads
                    .iter()
                    .flat_map(|r| r.evidence.iter().map(|e| e.evidence.path.clone())),
            );
        }
        let mut observations = BTreeMap::new();
        for path in paths {
            reads.support += 1;
            let value = checkout.observe(&path);
            observations.insert(path, value);
        }
        let key = knowledge::fingerprint(&serde_json::to_vec(&json!({"repository":repository,
            "revision":checkout.revision,"branch":checkout.branch,"default_branch":checkout.default_branch,
            "dirty":checkout.dirty()?,"events":events,"evaluator":knowledge::evidence::current_identity(),"history":history(&options.root, true)?,
            "observations":observations.iter().map(|(p,o)|(p,&o.metadata)).collect::<BTreeMap<_,_>>()
        }))?);
        checkout.ensure_head()?;
        Ok(Self {
            journal: Some(journal),
            key,
            checkout: Some(checkout),
            claims,
            observations,
        })
    }
    fn assess(&self) -> Result<Value> {
        let Some(checkout) = &self.checkout else {
            return Ok(json!({"status":"not_configured","items":[]}));
        };
        let assessment = context::assess_with_reader(checkout, &self.claims, None, |path| {
            Ok(self
                .observations
                .get(path)
                .context("applicable review support changed during assessment; retry")?
                .clone())
        })?;
        let items = assessment.items.iter().map(|item| json!({
            "id":item.knowledge.claim.id, "status":item.status, "reason":item.reason,
            "review_heads":item.review_heads, "review_conflict":item.review_conflict,
            "relationship_conflict":item.relationship_conflict,"invalid_relationships":item.invalid_relationships,
            "evidence":item.evidence.iter().map(|e| {
                json!({"path":e.path,"anchor":e.anchor,"comparison":e.comparison,"problem":e.problem,"current_sha256":e.current_sha256})
            }).collect::<Vec<_>>()
        })).collect::<Vec<_>>();
        Ok(
            json!({"status":"current","revision":assessment.revision,"items":items,
            "contract":"Mechanical support comparison only; no semantic review was recorded."}),
        )
    }
}
fn cached(options: &Options, input: &Input) -> Option<Value> {
    let value = load(&options.root, "knowledge.json").ok().flatten()?;
    (value["version"] == 4
        && value["evaluator"] == knowledge::evidence::current_identity()
        && value["inputs"] == input.key
        && matches!(
            value["assessment"]["status"].as_str(),
            Some("current" | "not_configured")
        )
        && value["assessment"]["items"].is_array())
    .then(|| value["assessment"].clone())
}

// Deepening a shallow checkout or changing replacement/graft refs can change
// ancestry without moving HEAD or changing the immutable knowledge journal.
fn history(root: &Path, exact: bool) -> Result<Value> {
    let git = |args: &[&str]| -> Result<String> {
        let output = crate::git::command(root)?.args(args).output()?;
        ensure!(output.status.success(), "cannot observe Git history inputs");
        String::from_utf8(output.stdout).context("Git history path is not UTF-8")
    };
    let files = git(&[
        "rev-parse",
        "--git-path",
        "shallow",
        "--git-path",
        "info/grafts",
    ])?;
    let mut observations = Vec::new();
    for file in files.lines() {
        if !exact {
            observations.push(Some(metadata(&root.join(file)).to_string()));
            continue;
        }
        match std::fs::read(root.join(file)) {
            Ok(bytes) => observations.push(Some(knowledge::fingerprint(&bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => observations.push(None),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(
        json!({"boundaries":observations,"replacements":git(&["for-each-ref","--format=%(refname) %(objectname)","refs/replace"])?}),
    )
}
fn metadata(path: &Path) -> Value {
    match crate::files::stamp(path) {
        Ok(stamp) => json!(stamp),
        Err(e) => json!({"error":format!("{e:#}")}),
    }
}
impl Watcher {
    fn observe(&self, options: &Options) -> Result<String> {
        let mut segments = BTreeMap::new();
        if let Some(directory) = &self.journal {
            match std::fs::read_dir(directory) {
                Ok(entries) => {
                    for entry in entries {
                        let path = entry?.path();
                        if path.extension().is_some_and(|e| e == "json") {
                            segments.insert(path.clone(), metadata(&path));
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        let checkout = if self.git {
            let run = |args: &[&str]| -> Result<String> {
                let out = crate::git::command(&options.root)?.args(args).output()?;
                ensure!(out.status.success(), "cannot observe checkout metadata");
                Ok(String::from_utf8(out.stdout)?)
            };
            json!({"head":run(&["rev-parse","HEAD","--abbrev-ref","HEAD"])?,
                "dirty":!run(&["status","--porcelain","--untracked-files=normal","--",".",":(exclude).mimirs/knowledge"])?.trim().is_empty(),
                "history":history(&options.root,false)?})
        } else {
            Value::Null
        };
        Ok(knowledge::fingerprint(&serde_json::to_vec(&json!({
            "evaluator":knowledge::evidence::current_identity(),"settings":metadata(&knowledge::settings::path(&options.root)),
            "repository":options.repository,"default_branch":options.default_branch,"state":options.state,
            "checkout":checkout,"segments":segments,
            "support":self.paths.iter().map(|p|(p,metadata(&options.root.join(p)))).collect::<BTreeMap<_,_>>()
        }))?))
    }
    pub fn refresh(
        &mut self,
        options: &Options,
        force: bool,
        reads: &mut Reads,
    ) -> Result<(bool, bool)> {
        let cache_path = options.root.join(".mimirs/watch/knowledge.json");
        if !force
            && self.metadata.is_some()
            && self.cache == crate::files::stamp(&cache_path).ok()
            && self.metadata.as_ref() == Some(&self.observe(options)?)
        {
            return Ok((false, false));
        }
        self.metadata = None;
        let input = Input::capture(options, reads, &mut self.target)?;
        self.paths = input.observations.keys().cloned().collect();
        self.journal = input.journal.clone();
        self.git = input.checkout.is_some();
        let before = self.observe(options)?;
        let cached = cached(options, &input);
        let assessed = cached.is_none() && input.checkout.is_some();
        let assessment = match cached {
            Some(value) => value,
            None => input.assess()?,
        };
        ensure!(
            Input::capture(options, reads, &mut None)?.key == input.key,
            "knowledge inputs changed during assessment; retry pending"
        );
        let after = self.observe(options)?;
        ensure!(
            before == after,
            "knowledge metadata changed during assessment; retry pending"
        );
        let published = persist(
            &options.root,
            "knowledge.json",
            &json!({"version":4,"evaluator":knowledge::evidence::current_identity(),"inputs":input.key,"assessment":assessment}),
        )?;
        self.cache = crate::files::stamp(&cache_path).ok();
        self.metadata = Some(after);
        Ok((assessed, published))
    }
}
#[cfg(test)]
pub fn refresh(options: &Options) -> Result<(bool, bool)> {
    Watcher::default().refresh(options, true, &mut Reads::default())
}
pub fn read(options: &Options) -> Value {
    let result = (|| -> Result<Value> {
        let input = Input::capture(options, &mut Reads::default(), &mut None)?;
        let (origin, assessment) = match cached(options, &input) {
            Some(value) => ("cache", value),
            None => ("live", input.assess()?),
        };
        anyhow::ensure!(
            Input::capture(options, &mut Reads::default(), &mut None)?.key == input.key,
            "knowledge inputs changed during read; retry"
        );
        Ok(json!({"origin":origin,"assessment":assessment}))
    })();
    result.unwrap_or_else(|e| json!({"status":"unavailable","reason":format!("{e:#}")}))
}
