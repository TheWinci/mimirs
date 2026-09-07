use super::*;

struct Leaf<'a> {
    source: String,
    local: Option<String>,
    evidence: Node<'a>,
}
fn join(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        path.into()
    } else if path.is_empty() {
        prefix.into()
    } else {
        format!("{prefix}::{path}")
    }
}
fn terminal(path: &str) -> String {
    path.rsplit("::").next().unwrap_or(path).into()
}
fn leaves<'a>(c: &Context<'_>, n: Node<'a>, prefix: &str) -> Vec<Leaf<'a>> {
    match n.kind() {
        "use_declaration" => n
            .child_by_field_name("argument")
            .map(|n| leaves(c, n, prefix))
            .unwrap_or_default(),
        "scoped_use_list" => {
            let path = join(
                prefix,
                n.child_by_field_name("path")
                    .map(|n| c.text(n))
                    .unwrap_or(""),
            );
            n.child_by_field_name("list")
                .map(|n| leaves(c, n, &path))
                .unwrap_or_default()
        }
        "use_list" => children(n)
            .into_iter()
            .flat_map(|n| leaves(c, n, prefix))
            .collect(),
        "use_as_clause" => {
            let source = join(
                prefix,
                n.child_by_field_name("path")
                    .map(|n| c.text(n))
                    .unwrap_or(""),
            );
            if source.is_empty() {
                Vec::new()
            } else {
                let local = Some(
                    n.child_by_field_name("alias")
                        .map(|n| c.text(n).into())
                        .unwrap_or_else(|| terminal(&source)),
                );
                vec![Leaf {
                    source,
                    local,
                    evidence: n,
                }]
            }
        }
        "use_wildcard" => {
            let text = c.text(n);
            let path = if text == "*" {
                ""
            } else {
                text.strip_suffix("::*").unwrap_or(text)
            };
            let source = join(prefix, path);
            if source.is_empty() {
                Vec::new()
            } else {
                vec![Leaf {
                    source,
                    local: None,
                    evidence: n,
                }]
            }
        }
        "self" if !prefix.is_empty() => vec![Leaf {
            source: prefix.into(),
            local: Some(terminal(prefix)),
            evidence: n,
        }],
        "identifier" | "type_identifier" | "scoped_identifier" | "crate" | "super" => {
            let source = join(prefix, c.text(n));
            let local = Some(terminal(&source));
            vec![Leaf {
                source,
                local,
                evidence: n,
            }]
        }
        _ => Vec::new(),
    }
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "identifier" => {
            c.text(n) == name
                && name != "_"
                && name
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.to_lowercase().to_string() == ch.to_string())
        }
        "shorthand_field_identifier" | "shorthand_field_identifier_pattern" => c.text(n) == name,
        "self" => name == "self",
        "scoped_identifier" | "field_expression" | "type_identifier" => false,
        "match_pattern" => pattern(c, n.named_child(0), name),
        "tuple_struct_pattern" | "struct_pattern" => children(n)
            .into_iter()
            .filter(|child| Some(*child) != n.child_by_field_name("type"))
            .any(|n| pattern(c, Some(n), name)),
        "field_pattern" => pattern(
            c,
            n.child_by_field_name("pattern")
                .or_else(|| n.child_by_field_name("name")),
            name,
        ),
        _ => children(n).into_iter().any(|n| pattern(c, Some(n), name)),
    }
}
fn parameter(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "parameters" | "closure_parameters" => {
            children(n).into_iter().any(|n| parameter(c, Some(n), name))
        }
        "parameter" => pattern(c, n.child_by_field_name("pattern"), name),
        "self_parameter" => name == "self",
        _ => pattern(c, Some(n), name),
    }
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str, macro_call: bool) -> Option<Resolved> {
    let named = || {
        n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    };
    let target = |kinds| {
        Some(
            c.declared(n, name, kinds)
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        )
    };
    match n.kind() {
        "use_declaration" => leaves(c, n, "")
            .iter()
            .any(|l| l.local.as_deref() == Some(name))
            .then_some(Resolved::IMPORT),
        "extern_crate_declaration" => n
            .child_by_field_name("name")
            .filter(|node| {
                n.child_by_field_name("alias")
                    .map(|n| c.text(n))
                    .unwrap_or_else(|| c.text(*node))
                    == name
            })
            .map(|_| Resolved::IMPORT),
        "mod_item" => named().then(|| {
            if n.child_by_field_name("body").is_none() {
                Resolved::IMPORT
            } else {
                Resolved::LOCAL
            }
        }),
        "macro_definition" if macro_call && named() => target(&["function", "method", "macro"]),
        "function_item" if !macro_call && named() => target(&["function", "method", "macro"]),
        "let_declaration" if !macro_call && pattern(c, n.child_by_field_name("pattern"), name) => {
            target(&["function", "method", "macro"])
        }
        "struct_item" | "union_item" | "enum_item" | "trait_item" | "type_item"
            if !macro_call && named() =>
        {
            target(&["type", "struct", "enum", "trait"])
        }
        "const_item" | "static_item" if !macro_call && named() => Some(Resolved::LOCAL),
        _ => None,
    }
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "type_identifier" | "self" | "crate" | "super" => Some(c.text(n)),
        "scoped_identifier" => n
            .child_by_field_name("path")
            .and_then(|n| callee_root(c, n)),
        "field_expression" => n
            .child_by_field_name("value")
            .and_then(|n| callee_root(c, n)),
        "generic_function" | "generic_type" => n
            .child_by_field_name("function")
            .or_else(|| n.child_by_field_name("type"))
            .and_then(|n| callee_root(c, n)),
        "call_expression" => n
            .child_by_field_name("function")
            .and_then(|n| callee_root(c, n)),
        "parenthesized_expression" => n.named_child(0).and_then(|n| callee_root(c, n)),
        _ => None,
    }
}
fn assignment(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let n = if n.kind() == "expression_statement" {
        n.named_child(0)?
    } else {
        n
    };
    (n.kind() == "assignment_expression"
        && n.child_by_field_name("left")
            .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name))
    .then_some(Resolved::LOCAL)
}
fn contains(n: Option<Node<'_>>, call: Node<'_>) -> bool {
    n.is_some_and(|n| encloses(n, call))
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    if matches!(n.kind(), "if_expression" | "while_expression") {
        let condition = n.child_by_field_name("condition");
        let body = n.child_by_field_name(if n.kind() == "if_expression" {
            "consequence"
        } else {
            "body"
        });
        if (contains(condition, call) || contains(body, call))
            && condition.is_some_and(|n| {
                walk(n).into_iter().any(|n| {
                    n.kind() == "let_condition"
                        && n.child_by_field_name("value")
                            .is_none_or(|n| n.end_byte() <= call.start_byte())
                        && pattern(c, n.child_by_field_name("pattern"), name)
                })
            })
        {
            return Some(Resolved::LOCAL);
        }
    }
    ((n.kind() == "for_expression"
        && contains(n.child_by_field_name("body"), call)
        && pattern(c, n.child_by_field_name("pattern"), name))
        || (n.kind() == "match_arm" && pattern(c, n.child_by_field_name("pattern"), name)))
    .then_some(Resolved::LOCAL)
}
fn resolve(c: &Context<'_>, call: Node<'_>, callee: Node<'_>) -> Resolved {
    let Some(name) = callee_root(c, callee) else {
        return Resolved::UNKNOWN;
    };
    let macro_call = call.kind() == "macro_invocation";
    let mut parent = call.parent();
    while let Some(n) = parent {
        if let Some(b) = control(c, n, call, name) {
            return b;
        }
        if matches!(n.kind(), "function_item" | "closure_expression")
            && parameter(c, n.child_by_field_name("parameters"), name)
        {
            return Resolved::LOCAL;
        }
        if n.kind() == "block" {
            if let Some(b) = children(n)
                .into_iter()
                .take_while(|n| n.end_byte() <= call.start_byte())
                .filter_map(|n| {
                    if n.kind() == "let_declaration" {
                        declaration(c, n, name, macro_call)
                    } else {
                        assignment(c, n, name)
                    }
                })
                .last()
            {
                return b;
            }
            if let Some(b) = children(n)
                .into_iter()
                .filter(|n| !matches!(n.kind(), "let_declaration" | "expression_statement"))
                .find_map(|n| declaration(c, n, name, macro_call))
            {
                return b;
            }
        } else if (n.kind() == "source_file"
            || (n.kind() == "declaration_list"
                && n.parent().is_some_and(|n| n.kind() == "mod_item")))
            && let Some(b) = children(n)
                .into_iter()
                .find_map(|n| declaration(c, n, name, macro_call))
        {
            return b;
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn scoped(n: Node<'_>) -> Option<Node<'_>> {
    if n.kind() == "scoped_identifier" {
        Some(n)
    } else if n.kind() == "generic_function" {
        n.child_by_field_name("function").and_then(scoped)
    } else {
        None
    }
}
fn refine(
    c: &Context<'_>,
    root: Node<'_>,
    call: Node<'_>,
    callee: Node<'_>,
    binding: Resolved,
) -> Resolved {
    let Some(scoped) = scoped(callee) else {
        return binding;
    };
    let targets = || -> Option<Vec<ChunkRef>> {
        let name = callee_root(c, scoped.child_by_field_name("path")?)?;
        let member = c.text(scoped.child_by_field_name("name")?);
        let mut targets = Vec::new();
        if binding.target.as_ref().is_some_and(|t| t.kind == "enum") {
            for item in children(root).into_iter().filter(|n| {
                n.kind() == "enum_item"
                    && n.child_by_field_name("name")
                        .is_some_and(|n| c.text(n) == name)
            }) {
                targets.extend(
                    walk(item)
                        .into_iter()
                        .filter(|n| {
                            n.kind() == "enum_variant"
                                && n.child_by_field_name("name")
                                    .is_some_and(|n| c.text(n) == member)
                        })
                        .filter_map(|n| c.declared(n, member, &["constant"])),
                );
            }
        }
        let impls: Vec<_> = if name == "Self" {
            walk(root)
                .into_iter()
                .filter(|n| n.kind() == "impl_item" && encloses(*n, call))
                .collect()
        } else {
            children(root)
                .into_iter()
                .filter(|n| {
                    n.kind() == "impl_item"
                        && n.child_by_field_name("trait").is_none()
                        && callee_root(c, n.child_by_field_name("type").unwrap_or(*n)) == Some(name)
                })
                .collect()
        };
        for item in impls {
            if let Some(body) = item.child_by_field_name("body") {
                targets.extend(
                    children(body)
                        .into_iter()
                        .filter(|n| {
                            n.kind() == "function_item"
                                && n.child_by_field_name("name")
                                    .is_some_and(|n| c.text(n) == member)
                        })
                        .filter_map(|n| c.declared(n, member, &["function", "method", "macro"])),
                );
            }
        }
        Some(targets)
    };
    let mut targets = targets().unwrap_or_default();
    if targets.len() == 1 {
        return Resolved::target(targets.remove(0));
    }
    if binding
        .target
        .as_ref()
        .is_some_and(|t| matches!(t.kind.as_str(), "type" | "struct" | "enum" | "trait"))
    {
        Resolved::LOCAL
    } else {
        binding
    }
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        match n.kind() {
            "use_declaration" => {
                for leaf in leaves(c, n, "") {
                    let mut fact = c.import(leaf.source, "*", leaf.evidence, c.owner(n));
                    if let Kind::Import { local, .. } = &mut fact.kind {
                        *local = leaf.local;
                    }
                    facts.push(fact);
                }
            }
            "extern_crate_declaration" | "mod_item" => {
                let module = n.kind() == "mod_item";
                if module && n.child_by_field_name("body").is_some() {
                    continue;
                }
                if let Some(name) = n.child_by_field_name("name") {
                    let owner = if module {
                        c.owner_where(n, |chunk| {
                            chunk.kind != "module" || chunk.name.as_deref() != Some(c.text(name))
                        })
                    } else {
                        c.owner(n)
                    };
                    let mut fact = c.import(
                        c.text(name).into(),
                        if module { "module" } else { "*" },
                        name,
                        owner,
                    );
                    if let Kind::Import {
                        local, is_static, ..
                    } = &mut fact.kind
                    {
                        *local = Some(
                            c.text(if module {
                                name
                            } else {
                                n.child_by_field_name("alias").unwrap_or(name)
                            })
                            .into(),
                        );
                        *is_static = module;
                    }
                    facts.push(fact);
                }
            }
            "call_expression" | "macro_invocation" => {
                let is_macro = n.kind() == "macro_invocation";
                if let Some(callee) =
                    n.child_by_field_name(if is_macro { "macro" } else { "function" })
                {
                    let text = if is_macro {
                        format!("{}!", c.text(callee))
                    } else {
                        c.text(callee).into()
                    };
                    facts.push(c.call(
                        text,
                        n,
                        refine(c, root, n, callee, resolve(c, n, callee)),
                        c.owner(n),
                    ));
                }
            }
            _ => {}
        }
    }
    facts
}
