use super::*;

fn target<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    n.child_by_field_name("target").map(|n| c.text(n))
}
fn operator<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    n.child_by_field_name("operator").map(|n| c.text(n))
}
fn directive<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    target(c, n).filter(|s| matches!(*s, "alias" | "import" | "require" | "use"))
}
fn definition(s: &str) -> bool {
    matches!(
        s,
        "def" | "defp" | "defmacro" | "defmacrop" | "defguard" | "defguardp" | "defdelegate"
    )
}
struct Entry<'a> {
    source: String,
    imported: String,
    local: Option<String>,
    evidence: Node<'a>,
}
fn imports<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<Entry<'a>> {
    let (Some(kind), Some(args)) = (directive(c, n), named(n, "arguments")) else {
        return Vec::new();
    };
    if kind == "alias"
        && let Some(dot) = named(args, "dot")
        && let (Some(prefix), Some(tuple)) = (
            dot.child_by_field_name("left"),
            dot.child_by_field_name("right")
                .filter(|n| n.kind() == "tuple"),
        )
    {
        return children(tuple)
            .into_iter()
            .filter(|n| n.kind() == "alias")
            .map(|n| Entry {
                source: format!("{}.{}", c.text(prefix), c.text(n)),
                imported: kind.into(),
                local: Some(c.text(n).into()),
                evidence: n,
            })
            .collect();
    }
    let Some(direct) = named(args, "alias") else {
        return Vec::new();
    };
    let keywords = named(args, "keywords");
    if kind == "import" {
        let filter = keywords.and_then(|n| {
            children(n).into_iter().find(|n| {
                n.kind() == "pair"
                    && ["only:", "except:"]
                        .iter()
                        .any(|prefix| c.text(*n).trim_start().starts_with(prefix))
            })
        });
        if let Some(filter) = filter {
            let except = c.text(filter).trim_start().starts_with("except:");
            let selectors: Vec<_> = children(filter)
                .into_iter()
                .flat_map(children)
                .flat_map(children)
                .filter(|n| n.kind() == "pair")
                .collect();
            if !selectors.is_empty() {
                return selectors
                    .into_iter()
                    .map(|n| {
                        let name = named(n, "keyword").map(|n| {
                            c.text(n)
                                .trim_end()
                                .strip_suffix(':')
                                .unwrap_or_else(|| c.text(n))
                                .to_owned()
                        });
                        let arity = named(n, "integer")
                            .map(|n| c.text(n))
                            .unwrap_or("undefined");
                        Entry {
                            source: c.text(direct).into(),
                            imported: format!(
                                "{}{}/{arity}",
                                if except { "except " } else { "" },
                                name.as_deref().unwrap_or("undefined")
                            ),
                            local: if except { None } else { name },
                            evidence: n,
                        }
                    })
                    .collect();
            }
        }
    }
    let mut local = matches!(kind, "alias" | "require").then(|| {
        c.text(direct)
            .rsplit('.')
            .next()
            .unwrap_or_else(|| c.text(direct))
            .into()
    });
    if let Some(alias) = keywords
        .and_then(|n| {
            children(n)
                .into_iter()
                .find(|n| n.kind() == "pair" && c.text(*n).trim_start().starts_with("as:"))
        })
        .and_then(|n| named(n, "alias"))
    {
        local = Some(c.text(alias).into());
    }
    vec![Entry {
        source: c.text(direct).into(),
        imported: kind.into(),
        local,
        evidence: direct,
    }]
}
fn head<'a>(c: &Context<'_>, n: Node<'a>) -> Option<Node<'a>> {
    let head = named(n, "arguments")?.named_child(0)?;
    if head.kind() == "binary_operator" && operator(c, head) == Some("when") {
        head.child_by_field_name("left")
    } else {
        Some(head)
    }
}
fn definition_name<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if n.kind() != "call" || !target(c, n).is_some_and(definition) {
        return None;
    }
    let head = head(c, n)?;
    if head.kind() == "identifier" {
        Some(c.text(head))
    } else if head.kind() == "call" {
        target(c, head)
    } else {
        None
    }
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "identifier"
            if c.text(n)
                .starts_with(|ch: char| ch.is_ascii_lowercase() || ch == '_') =>
        {
            c.text(n) == name && name != "_"
        }
        "alias" | "atom" | "keyword" | "dot" => false,
        "unary_operator" if operator(c, n) == Some("^") => false,
        "pair" => pattern(c, children(n).last().copied(), name),
        "call" => pattern(c, named(n, "arguments"), name),
        "binary_operator" if matches!(operator(c, n), Some("when" | "=" | "<-" | "\\\\")) => {
            pattern(c, n.child_by_field_name("left"), name)
        }
        _ => children(n).into_iter().any(|n| pattern(c, Some(n), name)),
    }
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if definition_name(c, n) == Some(name)
        || (n.kind() == "binary_operator"
            && operator(c, n) == Some("=")
            && n.child_by_field_name("right")
                .is_some_and(|n| n.kind() == "anonymous_function")
            && n.child_by_field_name("left")
                .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name))
    {
        return Some(
            c.declared(n, name, &["function", "method"])
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        );
    }
    if n.kind() == "call"
        && imports(c, n)
            .iter()
            .any(|e| e.local.as_deref() == Some(name))
    {
        return Some(Resolved::IMPORT);
    }
    (n.kind() == "binary_operator"
        && operator(c, n) == Some("=")
        && pattern(c, n.child_by_field_name("left"), name))
    .then_some(Resolved::LOCAL)
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "alias" => Some(c.text(n)),
        "dot" => n
            .child_by_field_name("left")
            .and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn inside(mut node: Option<Node<'_>>, kind: &str) -> bool {
    while let Some(n) = node {
        if n.kind() == kind {
            return true;
        }
        node = n.parent();
    }
    false
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> bool {
    let kind = target(c, n);
    if !matches!(kind, Some("with" | "for"))
        || (kind == Some("with") && inside(Some(call), "else_block"))
    {
        return false;
    }
    named(n, "arguments").is_some_and(|n| {
        children(n).into_iter().any(|n| {
            n.end_byte() <= call.start_byte()
                && n.kind() == "binary_operator"
                && matches!(operator(c, n), Some("<-" | "="))
                && pattern(c, n.child_by_field_name("left"), name)
        })
    })
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "call"
            && target(c, n).is_some_and(definition)
            && head(c, n)
                .filter(|n| n.kind() == "call")
                .is_some_and(|n| pattern(c, named(n, "arguments"), name))
        {
            return Resolved::LOCAL;
        }
        if n.kind() == "stab_clause" && pattern(c, n.child_by_field_name("left"), name) {
            return Resolved::LOCAL;
        }
        if n.kind() == "call" && control(c, n, call, name) {
            return Resolved::LOCAL;
        }
        if matches!(n.kind(), "source" | "do_block" | "body") {
            let mut candidates = children(n)
                .into_iter()
                .filter(|n| definition_name(c, *n).is_some() || n.end_byte() <= call.start_byte())
                .filter_map(|n| declaration(c, n, name));
            match (candidates.next(), candidates.next()) {
                (Some(b), None) => return b,
                (Some(_), Some(_)) => return Resolved::LOCAL,
                _ => {}
            }
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn inside_attribute(c: &Context<'_>, n: Node<'_>) -> bool {
    let mut parent = n.parent();
    while let Some(n) = parent {
        if n.kind() == "unary_operator" && operator(c, n) == Some("@") {
            return true;
        }
        if matches!(n.kind(), "source" | "do_block" | "body") {
            return false;
        }
        parent = n.parent();
    }
    false
}
fn definition_head(c: &Context<'_>, n: Node<'_>) -> bool {
    let mut current = n;
    while let Some(parent) = current.parent() {
        if parent.kind() == "arguments" {
            break;
        }
        current = parent;
    }
    let Some(args) = current.parent().filter(|n| n.kind() == "arguments") else {
        return false;
    };
    let Some(wrapper) = args
        .parent()
        .filter(|n| n.kind() == "call" && target(c, *n).is_some_and(definition))
    else {
        return false;
    };
    head(c, wrapper).is_some_and(|head| encloses(head, n))
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root).into_iter().filter(|n| n.kind() == "call") {
        if let Some(kind) = directive(c, n) {
            for e in imports(c, n) {
                let mut fact = c.import(e.source, &e.imported, e.evidence, c.owner(n));
                if let Kind::Import {
                    local, is_static, ..
                } = &mut fact.kind
                {
                    *local = e.local;
                    *is_static = kind == "import";
                }
                facts.push(fact);
            }
            continue;
        }
        let Some(target_node) = n.child_by_field_name("target") else {
            continue;
        };
        let text = c.text(target_node);
        if definition(text)
            || matches!(
                text,
                "defmodule"
                    | "defprotocol"
                    | "defimpl"
                    | "defstruct"
                    | "defexception"
                    | "alias"
                    | "import"
                    | "require"
                    | "use"
                    | "if"
                    | "unless"
                    | "case"
                    | "cond"
                    | "with"
                    | "for"
                    | "receive"
                    | "try"
                    | "quote"
                    | "unquote"
                    | "unquote_splicing"
            )
            || inside_attribute(c, n)
            || definition_head(c, n)
        {
            continue;
        }
        let callee = text.strip_suffix('.').unwrap_or(text);
        facts.push(
            c.call(
                callee.into(),
                n,
                expression_root(c, target_node)
                    .map(|name| resolve(c, n, name))
                    .unwrap_or(Resolved::UNKNOWN),
                c.owner(n),
            ),
        );
    }
    facts
}
