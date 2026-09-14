use std::cell::Cell;

use super::*;

#[test]
fn terminal_redraws_preserve_diagnostics_and_round_elapsed_seconds() {
    let millis = Cell::new(0);
    let clock = || {
        let value = millis.get();
        millis.set(value + 1234);
        Duration::from_millis(value)
    };
    let mut output = Vec::new();
    let mut progress = Progress::new(Path::new("root"), &mut output, true, &clock);
    progress.walking("-", 0).unwrap();
    progress.walking("a.rs", 1).unwrap();
    progress
        .diagnostic("walk_error: locked: Permission denied")
        .unwrap();
    progress.indexing("a.rs", (0, 0), (0, 1), false).unwrap();
    progress
        .indexing("a.rs", (256, 257), (0, 1), false)
        .unwrap();
    progress.indexing("a.rs", (257, 257), (1, 1), true).unwrap();
    progress.clear().unwrap();
    let output = String::from_utf8(output).unwrap().replace('\x1b', "<ESC>");
    assert_eq!(output, include_str!("../../../goldens/index/terminal.txt"));
}

#[test]
fn control_characters_in_paths_and_errors_are_printed_as_text() {
    let mut output = Vec::new();
    let mut progress = Progress::new(Path::new("root\n"), &mut output, false, &|| Duration::ZERO);
    progress.walking("bad\x1b[2J\t.rs", 1).unwrap();
    progress.diagnostic("error\r\nnext").unwrap();
    let output = String::from_utf8(output).unwrap();
    assert!(!output.contains('\x1b'));
    assert!(output.contains("root\\n"));
    assert!(output.contains("bad\\u{1b}[2J\\t.rs"));
    assert!(output.contains("error\\r\\nnext"));
}

#[test]
fn percentages_round_and_zero_totals_distinguish_started_from_finished() {
    assert_eq!(percent((1, 3)), 33);
    assert_eq!(percent((2, 3)), 67);
    assert_eq!(percent((0, 0)), 0);
    assert_eq!(Work::Unknown.label("documents"), "unknown (documents)");
    assert_eq!(Work::NotApplicable.label("documents"), "not applicable");
    assert_eq!(
        Work::Known { done: 0, total: 0 }.label("documents"),
        "0/0 documents (no work)"
    );
}
