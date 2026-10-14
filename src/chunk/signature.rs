use super::Chunk;

/// Most bytes a signature keeps before it is cut.
const SIGNATURE_BYTES: usize = 120;

/// A chunk's declaration on one line: its text after attached comments,
/// attributes and decorators, up to its body. A chunk without a body keeps its
/// whole declaration. A Markdown section is its heading line.
pub fn signature(text: &str, chunk: &Chunk) -> String {
    let span = &text[chunk.bytes.clone()];
    if chunk.kind == "section" {
        let heading = span.lines().next().unwrap_or("");
        return cut(heading.trim());
    }
    let start = declaration_start(span);
    let end = match &chunk.body {
        Some(body) => body.start - chunk.bytes.start,
        None => span.len(),
    };
    let declaration = one_line(&span[start..end.max(start)]);
    cut(declaration.trim_end_matches([' ', '{', ':']))
}

/// Where the declaration starts in `span`, past the comments, attributes and
/// decorators that the chunker attaches above it.
fn declaration_start(span: &str) -> usize {
    let mut position = 0;
    loop {
        let rest = &span[position..];
        let trimmed = rest.trim_start();
        let start = position + rest.len() - trimmed.len();
        let skipped = if trimmed.starts_with("//") || is_hash_comment(trimmed) {
            Some(line_length(trimmed))
        } else if trimmed.starts_with("/*") {
            trimmed.find("*/").map(|end| end + 2)
        } else if trimmed.starts_with("#[") || trimmed.starts_with('@') {
            Some(attribute_length(trimmed))
        } else {
            None
        };
        match skipped {
            Some(length) => position = start + length,
            None => return start,
        }
    }
}

/// A Python `#` comment; Rust attributes also start with `#` but go on with `[`.
fn is_hash_comment(text: &str) -> bool {
    text.starts_with('#') && !text.starts_with("#[")
}

fn line_length(text: &str) -> usize {
    text.find('\n').map_or(text.len(), |end| end + 1)
}

/// The length of a Rust attribute or a Python decorator, which may span lines
/// inside its brackets: up to its closing `]`, or to the end of its line.
fn attribute_length(text: &str) -> usize {
    let mut depth = 0;
    for (index, character) in text.char_indices() {
        match character {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 && text.starts_with("#[") {
                    return index + 1;
                }
            }
            '\n' if depth == 0 => return index + 1,
            _ => {}
        }
    }
    text.len()
}

/// Joins a declaration's lines with single spaces, and drops the spaces and
/// trailing commas that line breaks leave inside brackets.
fn one_line(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    joined
        .replace("( ", "(")
        .replace(", )", ")")
        .replace(" )", ")")
}

fn cut(text: &str) -> String {
    if text.len() <= SIGNATURE_BYTES {
        return text.to_string();
    }
    let mut end = SIGNATURE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &text[..end], super::ELISION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::chunk_file;

    /// The signature of the chunk named `name` in `text`.
    fn signature_of(path: &str, text: &str, name: &str) -> String {
        let chunks = chunk_file(path, text).expect("the file chunks");
        let chunk = chunks
            .iter()
            .find(|chunk| chunk.name.as_deref() == Some(name))
            .expect("the chunk exists");
        signature(text, chunk)
    }

    #[test]
    fn rust_doc_comments_and_attributes_are_skipped() {
        let text = include_str!("samples/cache.rs");
        assert_eq!(signature_of("cache.rs", text, "Cache"), "pub struct Cache");
        assert_eq!(
            signature_of("cache.rs", text, "get"),
            "pub fn get(&self, key: &str) -> Option<&String>"
        );
        assert_eq!(signature_of("cache.rs", text, "tests"), "mod tests");
    }

    #[test]
    fn a_rust_constant_keeps_its_whole_declaration() {
        let text = include_str!("samples/cache.rs");
        assert_eq!(
            signature_of("cache.rs", text, "MAX_ENTRIES"),
            "pub const MAX_ENTRIES: usize = 1_000;"
        );
    }

    #[test]
    fn a_multi_line_rust_signature_becomes_one_line() {
        let text = "\
#[derive(
    Debug,
)]
pub fn open(
    path: &Path,
    create: bool,
) -> Result<Store> {
    todo!()
}
";
        assert_eq!(
            signature_of("store.rs", text, "open"),
            "pub fn open(path: &Path, create: bool) -> Result<Store>"
        );
    }

    #[test]
    fn python_decorators_are_skipped() {
        let text = "\
@app.route(
    \"/items\",
)
@login_required
def items(request):
    return []
";
        assert_eq!(
            signature_of("views.py", text, "items"),
            "def items(request)"
        );
    }

    #[test]
    fn a_typescript_exported_function_keeps_its_export() {
        let text = include_str!("samples/queue.ts");
        let signature = signature_of("queue.ts", text, "createQueue");
        assert!(
            signature.starts_with("export function createQueue"),
            "{signature}"
        );
    }

    #[test]
    fn a_go_method_keeps_its_receiver_and_a_const_block_its_names() {
        let text = include_str!("samples/cache.go");
        let method = signature_of("cache.go", text, "Cache.Get");
        assert!(method.starts_with("func (c *Cache) Get("), "{method}");
        let constants = signature_of("cache.go", text, "MaxEntries");
        assert!(constants.starts_with("const ("), "{constants}");
        assert!(constants.contains("MaxEntries"), "{constants}");
    }

    #[test]
    fn a_long_signature_is_cut() {
        let text = format!("pub fn long({}) {{}}\n", "a: u8, ".repeat(30));
        let signature = signature_of("long.rs", &text, "long");
        assert!(signature.ends_with(crate::chunk::ELISION));
        assert!(signature.len() <= SIGNATURE_BYTES + crate::chunk::ELISION.len());
    }
}
