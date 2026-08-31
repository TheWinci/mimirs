use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;

use tempfile::TempDir;

use super::*;

fn write(dir: &TempDir, path: &str, contents: impl AsRef<[u8]>) {
    let path = dir.path().join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn empty_file_is_source() {
    let dir = TempDir::new().unwrap();
    write(&dir, "empty.rs", "");

    let source = read(dir.path(), "empty.rs").unwrap();

    assert_eq!(
        source,
        SourceFile {
            path: "empty.rs".to_string(),
            text: String::new(),
        }
    );
}

#[test]
fn unicode_source_is_not_normalized() {
    let dir = TempDir::new().unwrap();
    let text = "\u{feff}pub fn \u{017c}\u{00f3}\u{0142}\u{0107}() {}\r\n";
    write(&dir, "src/\u{017a}r\u{00f3}d\u{0142}o.rs", text);

    let source = read(dir.path(), "src/\u{017a}r\u{00f3}d\u{0142}o.rs").unwrap();

    assert_eq!(source.path, "src/\u{017a}r\u{00f3}d\u{0142}o.rs");
    assert_eq!(source.text, text);
}

#[test]
fn missing_file_error_names_the_path_and_retains_the_cause() {
    let dir = TempDir::new().unwrap();

    let error = read(dir.path(), "missing.rs").unwrap_err();

    assert!(error.to_string().contains("missing.rs"), "{error}");
    assert_eq!(
        error
            .root_cause()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        ErrorKind::NotFound
    );
}

#[test]
fn unreadable_file_error_names_the_path_and_retains_the_cause() {
    let dir = TempDir::new().unwrap();
    write(&dir, "locked.rs", "secret");
    let path = dir.path().join("locked.rs");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

    let error = read(dir.path(), "locked.rs").unwrap_err();

    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(error.to_string().contains("locked.rs"), "{error}");
    assert_eq!(
        error
            .root_cause()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        ErrorKind::PermissionDenied
    );
}

#[test]
fn invalid_utf8_error_names_the_path_and_retains_the_cause() {
    let dir = TempDir::new().unwrap();
    write(&dir, "invalid.rs", [0xbf, 0xf3, 0xb3, 0xe6]);

    let error = read(dir.path(), "invalid.rs").unwrap_err();

    assert!(error.to_string().contains("invalid.rs"), "{error}");
    assert!(
        error
            .root_cause()
            .downcast_ref::<std::string::FromUtf8Error>()
            .is_some()
    );
}
