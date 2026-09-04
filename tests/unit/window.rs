use super::*;
use crate::source::SourceFile;

fn source(text: &str) -> SourceFile {
    SourceFile {
        path: "src/main.rs".to_owned(),
        text: text.to_owned(),
    }
}

fn texts<'a>(windows: &'a [Window<'_, '_>]) -> Vec<&'a str> {
    windows.iter().map(|window| window.text.as_str()).collect()
}

#[test]
fn non_blank_lines_become_windows_in_source_order() {
    let source = source("first line\n\nsecond line\nthird line");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    let windows = of(&chunk);

    assert_eq!(texts(&windows), ["first line", "second line", "third line"]);
    assert!(
        windows
            .iter()
            .all(|window| std::ptr::eq(window.chunk, &chunk))
    );
}

#[test]
fn whitespace_only_lines_do_not_become_windows() {
    let source = source("\n \t \n\u{2003}\r\n");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    assert!(of(&chunk).is_empty());
}

#[test]
fn line_endings_are_removed_and_other_whitespace_is_preserved() {
    let source = source("  first  \r\n\tsecond\t\nlast  ");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    let windows = of(&chunk);

    assert_eq!(texts(&windows), ["  first  ", "\tsecond\t", "last  "]);
}

#[test]
fn punctuation_does_not_split_a_line() {
    let source = source("// First sentence. Second sentence!\n");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    let windows = of(&chunk);

    assert_eq!(texts(&windows), ["// First sentence. Second sentence!"]);
}

#[test]
fn unicode_text_is_not_normalized() {
    let source = source("zażółć gęślą\n日本語\n");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    assert_eq!(texts(&of(&chunk)), ["zażółć gęślą", "日本語"]);
}

#[test]
fn an_empty_chunk_has_no_windows() {
    let source = source("");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    assert!(of(&chunk).is_empty());
}

#[test]
fn repeated_windowing_is_stable() {
    let source = source("one\r\n\r\ntwo\n");
    let chunk = crate::chunk::of(&source).pop().unwrap();

    assert_eq!(of(&chunk), of(&chunk));
}
