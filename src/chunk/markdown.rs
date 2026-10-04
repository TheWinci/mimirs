use tree_sitter::{Language, Node};

use super::symbols::{Rules, Symbol};

pub const MARKDOWN: Rules = Rules {
    grammar,
    symbol,
    is_import,
};

fn grammar() -> Language {
    tree_sitter_md::LANGUAGE.into()
}

fn is_import(_node: Node, _text: &str) -> bool {
    false
}

/// A section that starts with a heading is a symbol named by the heading's
/// text. Its body is everything after the heading line, so a parent's text
/// keeps its own paragraphs and its subsections' headings. Text before the
/// first heading is a section without a heading and stays line chunks.
fn symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    if node.kind() != "section" {
        return None;
    }
    let heading = node
        .named_child(0)
        .filter(|child| matches!(child.kind(), "atx_heading" | "setext_heading"))?;
    let name = heading
        .child_by_field_name("heading_content")
        .map(|content| text[content.byte_range()].trim().to_string())
        .unwrap_or_default();
    Some(Symbol {
        kind: "section",
        name,
        body: Some(heading.end_byte()..node.end_byte()),
        members: Some(node),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::own_text;
    use crate::chunk::symbols::symbol_chunks;
    use crate::chunk::symbols::tests::{check_invariants, outline};

    const GUIDE: &str = include_str!("samples/guide.md");

    fn chunks() -> Vec<crate::chunk::Chunk> {
        let chunks = symbol_chunks(GUIDE, &MARKDOWN)
            .expect("the grammar loads")
            .expect("the sample parses");
        check_invariants(GUIDE, &chunks);
        chunks
    }

    #[test]
    fn sections_nest_by_heading_level() {
        // Front matter and text before the first heading stay line chunks. A
        // `#` line inside a code fence is content, and the grammar keeps a
        // setext heading (`Notes` underlined) inside the section above it.
        let expected = "\
section Guide 7-31
section Guide > Setup 11-19
section Guide > Usage 20-31
section Guide > Usage > Limits 24-31
lines - 1-5
";
        assert_eq!(outline(&chunks()), expected);
    }

    #[test]
    fn a_section_outline_lists_its_subsection_headings() {
        let chunks = chunks();
        assert_eq!(
            own_text(GUIDE, &chunks, 0),
            "# Guide\n\nHow to use the queue.\n\n## Setup\n…\n## Usage\n…\n"
        );
    }
}
