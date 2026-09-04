use super::*;

fn source(path: &str, text: &str) -> SourceFile {
    SourceFile {
        path: path.to_owned(),
        text: text.to_owned(),
    }
}

#[test]
fn every_source_produces_one_whole_file_chunk() {
    let source = source("src/main.rs", "fn main() {}\n");

    let chunks = of(&source);

    assert_eq!(chunks.len(), 1);
    let chunk = &chunks[0];
    assert!(std::ptr::eq(chunk.source, &source));
    assert_eq!(chunk.text, source.text);
    assert_eq!(chunk.byte_start, 0);
    assert_eq!(chunk.byte_end, source.text.len());
    assert_eq!((chunk.line_start, chunk.line_end), (1, 1));
}

#[test]
fn empty_source_produces_one_empty_chunk() {
    let source = source("empty.rs", "");

    let chunks = of(&source);

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].text, "");
    assert_eq!((chunks[0].byte_start, chunks[0].byte_end), (0, 0));
    assert_eq!((chunks[0].line_start, chunks[0].line_end), (1, 1));
}

#[test]
fn chunk_range_ends_on_the_line_containing_the_last_byte() {
    let cases = [
        ("one\ntwo", 2),
        ("one\ntwo\n", 2),
        ("one\r\ntwo\r\n", 2),
        ("\n\n", 2),
        ("żółć\n日本語", 2),
    ];

    for (text, expected_line_end) in cases {
        let source = source("source.rs", text);
        let chunk = of(&source).pop().unwrap();

        assert_eq!(chunk.line_end, expected_line_end, "source text: {text:?}");
        assert_eq!(&source.text[chunk.byte_start..chunk.byte_end], text);
    }
}

#[test]
fn repeated_chunking_is_stable() {
    let source = source("src/lib.rs", "pub fn żółć() {}\r\n");

    assert_eq!(of(&source), of(&source));
}
