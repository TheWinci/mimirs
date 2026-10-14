use std::path::Path;

use anyhow::{Context, bail};
use clap::Args;

use crate::chunk::{Chunk, chunk_file};
use crate::files::read::read_text;

#[derive(Args)]
pub struct Options {
    /// Files to outline, relative to the current folder.
    #[arg(required = true)]
    paths: Vec<String>,
}

pub fn run(options: Options) -> anyhow::Result<()> {
    let mut outlines = Vec::new();
    for path in &options.paths {
        outlines.push(outline_file(path)?);
    }
    print!("{}", outlines.join("\n"));
    Ok(())
}

fn outline_file(path: &str) -> anyhow::Result<String> {
    if Path::new(path).is_dir() {
        bail!("{path} is a directory; outline takes files, such as `mimirs outline {path}/*`");
    }
    let Some(text) = read_text(Path::new(path)).with_context(|| format!("cannot read {path}"))?
    else {
        bail!("{path} is not UTF-8 text");
    };
    outline(path, &text)
}

/// A header line, then one row per chunk in line order, with children
/// indented under their parent.
fn outline(path: &str, text: &str) -> anyhow::Result<String> {
    let chunks = chunk_file(path, text)?;
    let mut output = format!("{path} ({} lines)\n", text.lines().count());
    let top_level = children_of(&chunks, None);
    for index in top_level {
        write_rows(&mut output, path, &chunks, index, 0);
    }
    Ok(output)
}

/// The chunks directly under `parent`, by start line and then end line.
fn children_of(chunks: &[Chunk], parent: Option<usize>) -> Vec<usize> {
    let mut children: Vec<usize> = (0..chunks.len())
        .filter(|&index| chunks[index].parent == parent)
        .collect();
    children.sort_by_key(|&index| (chunks[index].start_line, chunks[index].end_line));
    children
}

fn write_rows(output: &mut String, path: &str, chunks: &[Chunk], index: usize, depth: usize) {
    let chunk = &chunks[index];
    let indent = "  ".repeat(depth);
    let mut row = format!(
        "{indent}{path}:{}-{}  {}",
        chunk.start_line, chunk.end_line, chunk.kind
    );
    if let Some(name) = &chunk.name {
        row.push_str("  ");
        row.push_str(name);
    }
    output.push_str(&row);
    output.push('\n');
    for child in children_of(chunks, Some(index)) {
        write_rows(output, path, chunks, child, depth + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_items_print_in_line_order_with_methods_under_their_impl() -> anyhow::Result<()> {
        let text = include_str!("../chunk/samples/cache.rs");
        let expected = "\
cache.rs (51 lines)
cache.rs:1-1  lines
cache.rs:3-6  imports
cache.rs:8-9  constant  MAX_ENTRIES
cache.rs:11-14  struct  Cache
cache.rs:16-25  impl  Cache
  cache.rs:17-19  method  new
  cache.rs:21-24  method  get
cache.rs:27-31  impl  Cache
  cache.rs:28-30  method  fmt
cache.rs:33-35  trait  Store
  cache.rs:34-34  method  load
cache.rs:37-41  macro  entry
cache.rs:43-51  module  tests
  cache.rs:47-50  function  starts_empty
";
        assert_eq!(outline("cache.rs", text)?, expected);
        Ok(())
    }

    #[test]
    fn python_nested_classes_print_under_their_class() -> anyhow::Result<()> {
        let text = include_str!("../chunk/samples/models.py");
        let expected = "\
models.py (48 lines)
models.py:1-1  lines
models.py:3-6  imports
models.py:8-8  constant  DEFAULT_TIMEOUT
models.py:9-9  constant  EMPTY_VALUES
models.py:12-17  class  ModelBase
  models.py:15-17  method  __new__
models.py:20-40  class  Article
  models.py:24-25  class  Meta
  models.py:27-29  method  __str__
  models.py:31-33  method  is_popular
  models.py:35-40  method  expires_in
models.py:43-44  function  get_article
models.py:47-48  lines
";
        assert_eq!(outline("models.py", text)?, expected);
        Ok(())
    }

    #[test]
    fn typescript_classes_and_namespaces_hold_their_members() -> anyhow::Result<()> {
        let text = include_str!("../chunk/samples/queue.ts");
        let expected = "\
queue.ts (67 lines)
queue.ts:1-1  lines
queue.ts:3-4  imports
queue.ts:6-7  constant  DEFAULT_LIMIT
queue.ts:9-12  interface  QueueOptions
queue.ts:14-14  type  Priority
queue.ts:16-19  enum  State
queue.ts:21-38  class  Queue
  queue.ts:27-27  method  constructor
  queue.ts:29-29  method  push
  queue.ts:30-30  method  size
  queue.ts:30-32  method  drain
  queue.ts:34-37  method  handleDone
queue.ts:40-45  function  createQueue
queue.ts:47-49  function  schedule
queue.ts:51-53  namespace  Scheduler
  queue.ts:52-52  function  start
queue.ts:55-59  namespace  global
  queue.ts:56-58  interface  Window
queue.ts:61-63  function  default
queue.ts:65-67  lines
";
        assert_eq!(outline("queue.ts", text)?, expected);
        Ok(())
    }

    #[test]
    fn go_methods_print_flat_because_they_have_no_parent() -> anyhow::Result<()> {
        let text = include_str!("../chunk/samples/cache.go");
        let expected = "\
cache.go (50 lines)
cache.go:1-2  lines
cache.go:4-7  imports
cache.go:9-10  constant  DefaultTTL
cache.go:12-15  constant  MaxEntries
cache.go:17-20  variable  hits
cache.go:22-25  types
  cache.go:23-23  type  Key
  cache.go:24-24  type  Value
cache.go:27-31  struct  Cache
cache.go:33-35  interface  Store
cache.go:37-40  function  NewCache
cache.go:42-48  method  Cache.Get
cache.go:50-50  method  Cache.Len
";
        assert_eq!(outline("cache.go", text)?, expected);
        Ok(())
    }

    #[test]
    fn markdown_sections_nest_under_their_heading() -> anyhow::Result<()> {
        let text = include_str!("../chunk/samples/guide.md");
        let expected = "\
guide.md (31 lines)
guide.md:1-5  lines
guide.md:7-31  section  Guide
  guide.md:11-19  section  Setup
  guide.md:20-31  section  Usage
    guide.md:24-31  section  Limits
";
        assert_eq!(outline("guide.md", text)?, expected);
        Ok(())
    }

    #[test]
    fn an_empty_file_prints_only_its_header() -> anyhow::Result<()> {
        assert_eq!(outline("empty.rs", "")?, "empty.rs (0 lines)\n");
        Ok(())
    }

    #[test]
    fn a_directory_suggests_a_glob() -> anyhow::Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().to_string_lossy().to_string();
        let error = outline_file(&path).expect_err("a directory is refused");
        assert!(error.to_string().contains("is a directory"));
        Ok(())
    }

    #[test]
    fn a_file_that_is_not_utf8_is_refused() -> anyhow::Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("image.bin");
        std::fs::write(&path, [0xff, 0xfe, 0x00])?;
        let error = outline_file(&path.to_string_lossy()).expect_err("binary is refused");
        assert!(error.to_string().contains("not UTF-8"));
        Ok(())
    }
}
