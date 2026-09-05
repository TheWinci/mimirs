use super::*;

fn analysis(text: &str) -> Analysis {
    crate::analysis::extract(SourceFile {
        path: "a.rs".into(),
        text: text.into(),
    })
    .unwrap()
}

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let connection = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    connection
        .execute("INSERT INTO files VALUES (1, 'a.rs')", [])
        .unwrap();
    (dir, connection)
}

#[test]
fn entity_snapshots_replace_rollback_and_delete() {
    let (_dir, mut connection) = database();
    let original = analysis("mod m { struct Café; struct Café; }\r\n");
    let tx = connection.transaction().unwrap();
    write(&tx, 1, &original).unwrap();
    tx.commit().unwrap();
    let (source, entities) = load_entities(&connection, "a.rs").unwrap().unwrap();
    assert_eq!(source, original.source);
    assert_eq!(entities, original.entities);
    {
        let tx = connection.transaction().unwrap();
        write(&tx, 1, &analysis("")).unwrap();
    }
    assert_eq!(
        load_entities(&connection, "a.rs").unwrap().unwrap().1,
        original.entities
    );
    let tx = connection.transaction().unwrap();
    write(&tx, 1, &analysis("")).unwrap();
    tx.commit().unwrap();
    assert!(
        load_entities(&connection, "a.rs")
            .unwrap()
            .unwrap()
            .1
            .is_empty()
    );
    connection.execute("DELETE FROM files", []).unwrap();
    assert!(load_entities(&connection, "a.rs").unwrap().is_none());
}

#[test]
fn invalid_entities_and_wrong_file_are_rejected() {
    let (_dir, mut connection) = database();
    for change in 0..5 {
        let mut a = analysis("struct Café;");
        match change {
            0 => a.entities[0].span.end = 999,
            1 => a.entities[0].span.start = 11,
            2 => a.entities[0].parent = Some(0),
            3 => a.entities[0].span.line_end = 99,
            _ => a.source.path = "other.rs".into(),
        }
        let tx = connection.transaction().unwrap();
        assert!(write(&tx, 1, &a).is_err());
    }
    assert!(load_entities(&connection, "a.rs").unwrap().is_none());
}

#[test]
fn v2_indexes_are_recognized_and_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("index.db");
    crate::storage::register_vec().unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(crate::storage::SCHEMA_V2).unwrap();
    connection.pragma_update(None, "user_version", 2).unwrap();
    drop(connection);
    assert_eq!(
        crate::storage::open(&path).unwrap().outcome,
        crate::storage::OpenOutcome::Rebuilt
    );
}

#[test]
fn all_fixtures_round_trip_complete_reports() {
    let (_dir, mut connection) = database();
    for text in [
        "",
        "fn f() { let x = 1 }",
        "fn (",
        "fn café() {}\r\n",
        include_str!("../fixtures/rust/declarations.rs"),
        include_str!("../fixtures/rust/comments.rs"),
        include_str!("../fixtures/rust/calls.rs"),
    ] {
        let a = analysis(text);
        let tx = connection.transaction().unwrap();
        write(&tx, 1, &a).unwrap();
        tx.commit().unwrap();
        let stored = load(&connection, "a.rs").unwrap().unwrap();
        assert_eq!(
            crate::analysis::report(&stored),
            crate::analysis::report(&a)
        );
        assert_eq!(stored, a);
    }
}

#[test]
fn invalid_facts_and_forced_save_failure_leave_no_mixed_snapshot() {
    let (_dir, mut connection) = database();
    let original = analysis("fn old() {}");
    let tx = connection.transaction().unwrap();
    write(&tx, 1, &original).unwrap();
    tx.commit().unwrap();
    for change in 0..5 {
        let mut a = analysis("use crate::{A}; fn changed() {}");
        match change {
            0 => a.facts[0].owner = Some(999),
            1 => a.facts[0].scope = 999,
            2 => a.facts[1].related = Some(999),
            3 => a.scopes[1].parent = Some(1),
            _ => a.facts[0].evidence[0].span.end = 999,
        }
        let tx = connection.transaction().unwrap();
        assert!(write(&tx, 1, &a).is_err());
    }
    connection.execute_batch("CREATE TRIGGER fail BEFORE INSERT ON analysis_records BEGIN SELECT RAISE(ABORT, 'forced'); END;").unwrap();
    {
        let tx = connection.transaction().unwrap();
        assert!(write(&tx, 1, &analysis("fn changed() {}")).is_err());
    }
    assert_eq!(load(&connection, "a.rs").unwrap().unwrap(), original);
    connection
        .execute("UPDATE analysis_records SET payload = 'broken'", [])
        .unwrap();
    assert!(load(&connection, "a.rs").is_err());
}
