use crate::{
    embedding::{self, Backend, Embedder},
    knowledge::{self, Store, checkout::Checkout, model::*},
    source::SourceFile,
    storage,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub struct Fixture {
    pub _temp: tempfile::TempDir,
    pub root: PathBuf,
    pub state: PathBuf,
    pub store: Store,
    pub repository: RepositoryId,
}
impl Fixture {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        let state = temp.path().join("state");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        fs::write(
            root.join("reader.rs"),
            "fn read_bytes() { preserve_original(); }\n",
        )
        .unwrap();
        fs::write(
            root.join("retry.rs"),
            "fn retry() { fail_after_three(); }\n",
        )
        .unwrap();
        fs::write(root.join(".gitignore"), ".mimirs/\n").unwrap();
        commit(&root);
        let repository = RepositoryId("test/context".into());
        let store = Store::open(&state, &repository).unwrap();
        Self {
            _temp: temp,
            root,
            state,
            store,
            repository,
        }
    }
    pub fn checkout(&self) -> Checkout {
        Checkout::open(&self.root, &self.repository).unwrap()
    }
    pub fn learn(
        &mut self,
        statement: &str,
        rationale: Option<&str>,
        paths: &[&str],
    ) -> KnowledgeId {
        self.store
            .learn(
                &self.checkout(),
                &actor(),
                KnowledgeKind::Discovery,
                statement,
                rationale.map(str::to_owned),
                &paths.iter().map(|p| (*p).into()).collect::<Vec<_>>(),
            )
            .unwrap()
    }
    pub fn events(&self) -> std::collections::BTreeMap<EventId, Event> {
        self.store.events().unwrap()
    }
    pub fn journal(&self) -> Vec<u8> {
        serde_json::to_vec(&self.events()).unwrap()
    }
    pub fn index(&self, files: &[(&str, &str)]) {
        fs::create_dir_all(self.root.join(".mimirs")).unwrap();
        fs::write(
            self.root.join(".mimirs/config.toml"),
            crate::config::Config::default().to_toml().unwrap(),
        )
        .unwrap();
        let mut db = storage::open(&self.root.join(".mimirs/index.db"))
            .unwrap()
            .connection;
        let budget =
            crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
        let policy = storage::policy::document_policy(&budget);
        for (path, text) in files {
            let analysis = crate::analysis::extract(SourceFile {
                path: (*path).into(),
                text: (*text).into(),
            })
            .unwrap();
            let docs = crate::retrieval::ts_v2::documents(&analysis).unwrap();
            storage::documents::save(
                &mut db,
                &analysis,
                storage::documents::Batch {
                    documents: &docs,
                    vectors: &vec![vector(); docs.len()],
                    policy: &policy,
                },
            )
            .unwrap();
        }
    }
}
pub fn actor() -> Actor {
    Actor {
        id: "reviewer".into(),
        kind: ActorKind::Agent,
        harness: None,
        session: None,
    }
}
pub fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
pub fn commit(root: &Path) {
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    );
}
pub fn vector() -> Vec<f32> {
    let mut v = vec![0.; embedding::DIMENSION];
    v[0] = 1.;
    v
}
pub struct Fixed;
impl Backend for Fixed {
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(crate::test_support::tokenizer(512))
    }
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        Ok(vec![vector(); texts.len()])
    }
}
pub fn fixed() -> anyhow::Result<Embedder> {
    Ok(Embedder::new(Fixed))
}
pub fn unused() -> anyhow::Result<Embedder> {
    panic!("embedder must not be initialized")
}

pub fn replace_revision(events: &mut std::collections::BTreeMap<EventId, Event>, commit: &str) {
    for event in events.values_mut() {
        match &mut event.payload {
            KnowledgeEvent::Created { claim } => claim.learned_at.commit = commit.into(),
            KnowledgeEvent::Verified { revision, .. } => revision.commit = commit.into(),
            _ => {}
        }
    }
    // This synthetic journal is only used to exercise unavailable history.
    assert!(!knowledge::projection::reduce(events).unwrap().is_empty());
}
