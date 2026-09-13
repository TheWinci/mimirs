use super::*;
use crate::config::Config;
use std::fs;

#[test]
fn streamed_order_matches_complete_path_sort_across_directory_boundaries() {
    let root = tempfile::tempdir().unwrap();
    for file in [
        "foo/a.rs",
        "foo.rs",
        "foo-/z.rs",
        "foo-/a.rs",
        "foo-1.rs",
        "foo/x/z.rs",
        "foo/x.rs",
        ".hidden.rs",
    ] {
        let path = root.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "text").unwrap();
    }
    let config = Config::default();
    let expected = crate::source::walk::discover(root.path(), &config.selection(), |_, _| Ok(()))
        .unwrap()
        .paths;
    let stream = Stream::start(
        root.path(),
        &config.selection(),
        &Profiler::default(),
        &Cancel::default(),
    )
    .unwrap();
    let mut paths = Vec::new();
    let mut completed = false;
    for event in stream {
        match event.unwrap() {
            Event::Path { path, ordinal } => {
                assert_eq!(ordinal, paths.len());
                paths.push(path);
            }
            Event::End { found } => {
                assert_eq!(found, paths.len());
                completed = true;
            }
            Event::Error(error) => panic!("{error}"),
        }
    }
    assert_eq!(paths, expected);
    assert!(completed);
}

#[test]
fn dropping_a_partially_consumed_stream_joins_a_blocked_walker() {
    let root = tempfile::tempdir().unwrap();
    for n in 0..200 {
        fs::write(root.path().join(format!("f{n:03}.rs")), "text").unwrap();
    }
    let cancel = Cancel::default();
    let mut stream = Stream::start(
        root.path(),
        &Config::default().selection(),
        &Profiler::default(),
        &cancel,
    )
    .unwrap();
    assert!(matches!(
        stream.next().unwrap().unwrap(),
        Event::Path { ordinal: 0, .. }
    ));
    drop(stream);
    assert!(cancel.is_cancelled());
}
