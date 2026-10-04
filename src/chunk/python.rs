use tree_sitter::{Language, Node};

use super::symbols::{Rules, Symbol};

pub const PYTHON: Rules = Rules {
    grammar,
    symbol,
    is_import,
};

fn grammar() -> Language {
    tree_sitter_python::LANGUAGE.into()
}

fn is_import(node: Node, _text: &str) -> bool {
    matches!(
        node.kind(),
        "import_statement" | "import_from_statement" | "future_import_statement"
    )
}

fn symbol<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    match node.kind() {
        "function_definition" => Some(definition(node, node, "function", text)),
        "class_definition" => Some(definition(node, node, "class", text)),
        // Decorators and the definition are one symbol, named by the definition.
        "decorated_definition" => {
            let inner = node.child_by_field_name("definition")?;
            let kind = if inner.kind() == "class_definition" {
                "class"
            } else {
                "function"
            };
            Some(definition(node, inner, kind, text))
        }
        "expression_statement" => module_constant(node, text),
        _ => None,
    }
}

/// A function or class whose name and body come from `definition`; `node` may
/// be the decorated wrapper around it. A function inside a class is a method.
fn definition<'tree>(
    node: Node<'tree>,
    definition: Node<'tree>,
    kind: &'static str,
    text: &str,
) -> Symbol<'tree> {
    let body = definition.child_by_field_name("body");
    let inside_class = node
        .parent()
        .and_then(|block| block.parent())
        .is_some_and(|owner| owner.kind() == "class_definition");
    let kind = if kind == "function" && inside_class {
        "method"
    } else {
        kind
    };
    let name = definition
        .child_by_field_name("name")
        .map(|name| text[name.byte_range()].to_string())
        .unwrap_or_default();
    Symbol {
        kind,
        name,
        body: body.map(|body| body.byte_range()),
        members: body.filter(|_| kind == "class"),
    }
}

/// `DEFAULT_TIMEOUT = 30` at module level is a constant named by its target.
/// Class attributes stay part of their class's text.
fn module_constant<'tree>(node: Node<'tree>, text: &str) -> Option<Symbol<'tree>> {
    if node.parent()?.kind() != "module" {
        return None;
    }
    let assignment = node
        .named_child(0)
        .filter(|child| child.kind() == "assignment")?;
    let target = assignment.child_by_field_name("left")?;
    if target.kind() != "identifier" {
        return None;
    }
    Some(Symbol {
        kind: "constant",
        name: text[target.byte_range()].to_string(),
        body: None,
        members: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::own_text;
    use crate::chunk::symbols::symbol_chunks;
    use crate::chunk::symbols::tests::{check_invariants, outline};

    const MODELS: &str = include_str!("samples/models.py");

    fn chunks() -> Vec<crate::chunk::Chunk> {
        let chunks = symbol_chunks(MODELS, &PYTHON)
            .expect("the grammar loads")
            .expect("the sample parses");
        check_invariants(MODELS, &chunks);
        chunks
    }

    #[test]
    fn definitions_methods_and_module_constants_are_chunks() {
        let expected = "\
constant DEFAULT_TIMEOUT 8-8
constant EMPTY_VALUES 9-9
class ModelBase 12-17
method ModelBase.__new__ 15-17
class Article 20-40
class Article.Meta 24-25
method Article.__str__ 27-29
method Article.is_popular 31-33
method Article.expires_in 35-40
function get_article 43-44
imports - 3-6
lines - 1-1
lines - 47-48
";
        assert_eq!(outline(&chunks()), expected);
    }

    #[test]
    fn a_class_outline_keeps_decorators_and_full_signatures() {
        let chunks = chunks();
        let article = chunks
            .iter()
            .position(|chunk| chunk.name.as_deref() == Some("Article"))
            .expect("Article is a chunk");
        let outline = own_text(MODELS, &chunks, article);
        assert!(
            outline.contains("    title = CharField(max_length=200)\n"),
            "{outline}"
        );
        assert!(
            outline.contains("    @property\n    def is_popular(self):\n        …"),
            "{outline}"
        );
        assert!(
            outline.contains("    def expires_in(\n        self,\n        days=1,\n    ):"),
            "{outline}"
        );
        assert!(!outline.contains("return self.title"), "{outline}");
    }
}
