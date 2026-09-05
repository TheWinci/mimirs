use super::*;
use std::fs;

#[test]
fn stored_inspection_matches_direct_and_never_reads_changed_or_deleted_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join(".mimirs")).unwrap();
    let database = root.join(".mimirs/index.db");
    let mut db = storage::open(&database).unwrap().connection;
    let text = "/// docs\nfn café() { missing( }\r\n";
    fs::write(root.join("a.rs"), text).unwrap();
    let a = analysis::extract(source::SourceFile {
        path: "a.rs".into(),
        text: text.into(),
    })
    .unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO files VALUES (1, 'a.rs')", [])
        .unwrap();
    storage::analysis::write(&tx, 1, &a).unwrap();
    tx.commit().unwrap();
    drop(db);
    let before = fs::read(&database).unwrap();
    let direct = report_at(root, Path::new("./a.rs"), false).unwrap();
    assert!(direct.contains("relation:"));
    let preview = serde_json::to_value(crate::retrieval::source::chunks(&a).unwrap()).unwrap();
    for file in [PathBuf::from("a.rs"), root.join("a.rs")] {
        assert_eq!(report_at(root, &file, true).unwrap(), direct);
    }
    fs::write(root.join("a.rs"), [255]).unwrap();
    assert_eq!(report_at(root, Path::new("a.rs"), true).unwrap(), direct);
    fs::remove_file(root.join("a.rs")).unwrap();
    assert_eq!(report_at(root, Path::new("a.rs"), true).unwrap(), direct);
    assert!(
        report_at(root, Path::new("missing.rs"), true)
            .unwrap_err()
            .to_string()
            .contains("no stored")
    );
    assert!(report_at(root, Path::new("../a.rs"), true).is_err());
    let stored = load_at(root, Path::new("a.rs"), true).unwrap();
    assert_eq!(
        serde_json::to_value(crate::retrieval::source::chunks(&stored).unwrap()).unwrap(),
        preview
    );
    assert_eq!(fs::read(database).unwrap(), before);
}

#[test]
fn missing_stored_database_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(report_at(dir.path(), Path::new("missing.rs"), true).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}
