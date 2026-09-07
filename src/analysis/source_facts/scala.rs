use super::*;

struct Entry<'a> {
    source: String,
    imported: String,
    local: Option<String>,
    evidence: Node<'a>,
}
fn renamed<'a>(c: &Context<'_>, n: Node<'a>, source: &str) -> Option<Entry<'a>> {
    let imported = c.text(n.child_by_field_name("name")?);
    let alias = c.text(n.child_by_field_name("alias")?);
    if imported.is_empty() || alias.is_empty() {
        return None;
    }
    Some(Entry {
        source: source.into(),
        imported: imported.into(),
        local: (alias != "_").then(|| alias.into()),
        evidence: n,
    })
}
fn imports<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<Entry<'a>> {
    let mut paths: Vec<_> = children(n)
        .into_iter()
        .filter(|n| n.kind() == "identifier")
        .map(|n| c.text(n))
        .collect();
    let selector = children(n)
        .into_iter()
        .find(|n| matches!(n.kind(), "namespace_selectors" | "namespace_wildcard"));
    let Some(selector) = selector else {
        if let Some(renamed_node) = children(n).into_iter().find(|n| {
            matches!(
                n.kind(),
                "arrow_renamed_identifier" | "as_renamed_identifier"
            )
        }) {
            return renamed(c, renamed_node, &paths.join("."))
                .into_iter()
                .collect();
        }
        let Some(imported) = paths.pop() else {
            return Vec::new();
        };
        return vec![Entry {
            source: paths.join("."),
            imported: imported.into(),
            local: Some(imported.into()),
            evidence: n,
        }];
    };
    let source = paths.join(".");
    if selector.kind() == "namespace_wildcard" {
        return vec![Entry {
            source,
            imported: if c.text(selector) == "given" {
                "given"
            } else {
                "*"
            }
            .into(),
            local: None,
            evidence: selector,
        }];
    }
    let mut entries = Vec::new();
    let nodes: Vec<_> = selector.children(&mut selector.walk()).collect();
    let mut index = 0;
    while let Some(&n) = nodes.get(index) {
        match n.kind() {
            "identifier" => entries.push(Entry {
                source: source.clone(),
                imported: c.text(n).into(),
                local: Some(c.text(n).into()),
                evidence: n,
            }),
            "arrow_renamed_identifier" | "as_renamed_identifier" => {
                entries.extend(renamed(c, n, &source))
            }
            "namespace_wildcard" => entries.push(Entry {
                source: source.clone(),
                imported: "*".into(),
                local: None,
                evidence: n,
            }),
            "given" => {
                if let Some(next) = (index + 1..nodes.len()).find(|&i| {
                    nodes[i].is_named()
                        && matches!(
                            nodes[i].kind(),
                            "type_identifier" | "generic_type" | "compound_type"
                        )
                }) {
                    entries.push(Entry {
                        source: source.clone(),
                        imported: format!("given {}", c.text(nodes[next])),
                        local: None,
                        evidence: nodes[next],
                    });
                    index = next;
                } else {
                    entries.push(Entry {
                        source: source.clone(),
                        imported: "given".into(),
                        local: None,
                        evidence: n,
                    });
                }
            }
            _ => {}
        }
        index += 1;
    }
    entries
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    if n.kind() == "identifier" {
        return c.text(n) == name;
    }
    if matches!(
        n.kind(),
        "type_identifier" | "stable_identifier" | "wildcard" | "alternative_pattern"
    ) {
        return false;
    }
    if let Some(named) = n
        .child_by_field_name("name")
        .filter(|n| n.kind() == "identifier")
    {
        if matches!(n.kind(), "parameter" | "class_parameter" | "binding") {
            return c.text(named) == name;
        }
        if n.kind() == "bind_pattern" {
            return c.text(named) == name
                || children(n)
                    .into_iter()
                    .filter(|n| *n != named)
                    .any(|n| pattern(c, Some(n), name));
        }
    }
    children(n).into_iter().any(|n| pattern(c, Some(n), name))
}
fn parameter(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    if n.kind() == "identifier" {
        return c.text(n) == name;
    }
    if matches!(n.kind(), "parameter" | "class_parameter" | "binding") {
        return pattern(c, Some(n.child_by_field_name("name").unwrap_or(n)), name);
    }
    children(n).into_iter().any(|n| parameter(c, n, name))
}
fn type_node(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_definition"
            | "object_definition"
            | "trait_definition"
            | "enum_definition"
            | "type_definition"
            | "package_object"
            | "given_definition"
    )
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let kinds: &[&str] = if matches!(n.kind(), "val_definition" | "var_definition")
        && pattern(c, n.child_by_field_name("pattern"), name)
    {
        &["function"]
    } else if matches!(n.kind(), "function_definition" | "function_declaration")
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    {
        &["function", "method"]
    } else if type_node(n)
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    {
        &["class", "trait", "enum", "type", "module", "given"]
    } else {
        if n.kind() == "import_declaration"
            && imports(c, n)
                .iter()
                .any(|e| e.local.as_deref() == Some(name))
        {
            return Some(Resolved::IMPORT);
        }
        return (n.kind() == "assignment_expression"
            && n.child_by_field_name("left")
                .or_else(|| n.named_child(0))
                .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name))
        .then_some(Resolved::LOCAL);
    };
    Some(
        c.declared(n, name, kinds)
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
    )
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "type_identifier" | "this" | "super" => Some(c.text(n)),
        "field_expression" => n
            .child_by_field_name("value")
            .and_then(|n| expression_root(c, n)),
        "generic_function" | "call_expression" => n
            .child_by_field_name("function")
            .and_then(|n| expression_root(c, n)),
        "parenthesized_expression" => n.named_child(0).and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> bool {
    if n.kind() == "for_expression" {
        let body = n
            .child_by_field_name("body")
            .or_else(|| children(n).last().copied());
        return n
            .child_by_field_name("enumerators")
            .or_else(|| named(n, "enumerators"))
            .is_some_and(|n| {
                children(n).into_iter().any(|n| {
                    n.kind() == "enumerator"
                        && pattern(c, n.named_child(0), name)
                        && (call.start_byte() >= n.end_byte()
                            || body.is_some_and(|n| encloses(n, call)))
                })
            });
    }
    n.kind() == "case_clause"
        && n.child_by_field_name("pattern")
            .or_else(|| n.named_child(0))
            .is_some_and(|n| pattern(c, Some(n), name) && call.start_byte() >= n.end_byte())
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "this" | "super") {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if control(c, n, call, name) {
            return Resolved::LOCAL;
        }
        if matches!(
            n.kind(),
            "function_definition"
                | "function_declaration"
                | "lambda_expression"
                | "extension_definition"
        ) && n
            .children_by_field_name("parameters", &mut n.walk())
            .any(|n| parameter(c, n, name))
        {
            return Resolved::LOCAL;
        }
        if n.kind() == "class_definition"
            && n.child_by_field_name("body")
                .or_else(|| named(n, "template_body"))
                .is_some_and(|n| encloses(n, call))
            && n.child_by_field_name("class_parameters")
                .or_else(|| named(n, "class_parameters"))
                .is_some_and(|n| parameter(c, n, name))
        {
            return Resolved::LOCAL;
        }
        if matches!(
            n.kind(),
            "block"
                | "indented_block"
                | "template_body"
                | "enum_body"
                | "with_template_body"
                | "compilation_unit"
                | "package_clause"
        ) {
            let future = matches!(
                n.kind(),
                "template_body" | "enum_body" | "with_template_body"
            );
            let mut candidates = children(n)
                .into_iter()
                .filter(|n| {
                    future
                        || type_node(*n)
                        || matches!(n.kind(), "function_definition" | "function_declaration")
                        || n.end_byte() <= call.start_byte()
                })
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
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "import_declaration" {
            for e in imports(c, n) {
                let mut fact = c.import(e.source, &e.imported, e.evidence, c.owner(n));
                if let Kind::Import { local, .. } = &mut fact.kind {
                    *local = e.local;
                }
                facts.push(fact);
            }
            continue;
        }
        let (callee, name) = match n.kind() {
            "call_expression" => {
                let Some(function) = n.child_by_field_name("function") else {
                    continue;
                };
                (c.text(function).to_owned(), expression_root(c, function))
            }
            "generic_function" => {
                if n.parent().is_some_and(|p| {
                    p.kind() == "call_expression" && p.child_by_field_name("function") == Some(n)
                }) {
                    continue;
                }
                (c.text(n).into(), expression_root(c, n))
            }
            "infix_expression" => {
                let (Some(left), Some(operator)) = (
                    n.child_by_field_name("left"),
                    n.child_by_field_name("operator"),
                ) else {
                    continue;
                };
                let operand = if c.text(operator).ends_with(':') {
                    n.child_by_field_name("right")
                } else {
                    Some(left)
                };
                (
                    format!("{} {}", c.text(left), c.text(operator)),
                    operand.and_then(|n| expression_root(c, n)),
                )
            }
            "instance_expression" => {
                let Some(t) = children(n).into_iter().find(|n| {
                    matches!(
                        n.kind(),
                        "type_identifier" | "generic_type" | "compound_type"
                    )
                }) else {
                    continue;
                };
                (c.text(t).into(), expression_root(c, t))
            }
            _ => continue,
        };
        if !callee.is_empty() {
            facts.push(
                c.call(
                    callee,
                    n,
                    name.map(|name| resolve(c, n, name))
                        .unwrap_or(Resolved::UNKNOWN),
                    c.owner(n),
                ),
            );
        }
    }
    facts
}
