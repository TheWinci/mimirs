use super::*;

#[test]
fn cleanup_failure_restores_every_deleted_row_and_metadata() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    save_text(&mut connection, "first.rs", "first\nsecond").unwrap();
    save_text(&mut connection, "last.rs", "last").unwrap();
    let before = snapshot(&connection);
    connection
        .execute_batch(
            "CREATE TRIGGER fail_cleanup BEFORE DELETE ON files WHEN OLD.path = 'last.rs'
         BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END;",
        )
        .unwrap();
    let error = reconcile(&mut connection, &[]).unwrap_err();
    assert!(format!("{error:#}").contains("cleanup failed"));
    assert_eq!(snapshot(&connection), before);
}

#[test]
fn cleanup_validates_metadata_without_stamping_or_erasing_it() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    connection
        .execute(
            "INSERT INTO index_metadata VALUES ('custom', 'preserve')",
            [],
        )
        .unwrap();
    let before = snapshot(&connection);
    reconcile(&mut connection, &[]).unwrap();
    assert_eq!(snapshot(&connection), before);
    save_text(&mut connection, "a.rs", "source").unwrap();
    connection
        .execute(
            "DELETE FROM index_metadata WHERE key = 'embedding_model'",
            [],
        )
        .unwrap();
    let before = snapshot(&connection);
    assert!(reconcile(&mut connection, &[],).is_err());
    assert_eq!(snapshot(&connection), before);
}
