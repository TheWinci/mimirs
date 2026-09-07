use super::*;
use std::collections::HashSet;

fn descendant<'a>(n: Node<'a>, kind: &str) -> Option<Node<'a>> {
    walk(n).into_iter().find(|n| n.kind() == kind)
}
fn unquote(value: &str) -> &str {
    let s = value.strip_prefix(['r', 'R']).unwrap_or(value);
    s.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(value)
}
fn shown(c: &Context<'_>, n: Node<'_>) -> Option<Vec<String>> {
    let mut shown: Option<Vec<String>> = None;
    let mut hidden = HashSet::new();
    for n in walk(n).into_iter().filter(|n| n.kind() == "combinator") {
        let names: Vec<String> = children(n)
            .into_iter()
            .filter(|n| n.kind() == "identifier")
            .map(|n| c.text(n).into())
            .collect();
        if c.text(n)
            .trim_start()
            .strip_prefix("hide")
            .is_some_and(|s| {
                s.chars()
                    .next()
                    .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
            })
        {
            hidden.extend(names);
        } else if !names.is_empty() {
            let mut seen = HashSet::new();
            shown = Some(
                names
                    .into_iter()
                    .filter(|name| {
                        shown.as_ref().is_none_or(|shown| shown.contains(name))
                            && seen.insert(name.clone())
                    })
                    .collect(),
            );
        }
    }
    shown.map(|names| names.into_iter().filter(|n| !hidden.contains(n)).collect())
}
fn alias<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    descendant(n, "import_specification")
        .and_then(|n| named(n, "identifier"))
        .map(|n| c.text(n))
}
fn imports(c: &Context<'_>, n: Node<'_>) -> Vec<Fact> {
    let owner = if n.kind() == "part_of_directive" {
        None
    } else {
        c.owner(n)
    };
    let uris: Vec<_> = walk(n).into_iter().filter(|n| n.kind() == "uri").collect();
    if matches!(n.kind(), "part_directive" | "part_of_directive") {
        let source = if n.kind() == "part_directive" {
            unquote(
                uris.first()
                    .map(|n| c.text(n.named_child(0).unwrap_or(*n)))
                    .unwrap_or(""),
            )
        } else {
            named(n, "dotted_identifier_list")
                .map(|n| c.text(n))
                .unwrap_or_else(|| unquote(uris.first().map(|n| c.text(*n)).unwrap_or("")))
        };
        return if source.is_empty() {
            Vec::new()
        } else {
            vec![c.import(
                source.into(),
                if n.kind() == "part_directive" {
                    "part"
                } else {
                    "part of"
                },
                n,
                owner,
            )]
        };
    }
    let shown = shown(c, n);
    if descendant(n, "library_export").is_some() {
        let source = unquote(
            uris.first()
                .map(|n| c.text(n.named_child(0).unwrap_or(*n)))
                .unwrap_or(""),
        );
        if source.is_empty() {
            return Vec::new();
        }
        return shown
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| vec!["*".into()])
            .into_iter()
            .map(|name| Fact {
                kind: Kind::Export {
                    exported: name.clone(),
                    local: (name != "*").then_some(name),
                    source: Some(source.into()),
                    type_only: false,
                },
                owner: owner.clone(),
                location: Location::from_span(&c.lines.span(n.start_byte(), n.end_byte())),
            })
            .collect();
    }
    let alias = alias(c, n);
    let mut facts = Vec::new();
    for (index, uri) in uris.into_iter().enumerate() {
        let source = unquote(c.text(uri.named_child(0).unwrap_or(uri)));
        if source.is_empty() {
            continue;
        }
        let entries = if index > 0 {
            vec![("conditional".into(), alias.map(str::to_owned))]
        } else if let Some(alias) = alias.filter(|s| !s.is_empty()) {
            vec![("*".into(), Some(alias.into()))]
        } else if let Some(shown) = shown.as_ref().filter(|s| !s.is_empty()) {
            shown.iter().map(|s| (s.clone(), Some(s.clone()))).collect()
        } else {
            vec![("*".into(), None)]
        };
        for (imported, local) in entries {
            let mut fact = c.import(
                source.into(),
                &imported,
                if index == 0 { n } else { uri },
                owner.clone(),
            );
            if let Kind::Import { local: binding, .. } = &mut fact.kind {
                *binding = local;
            }
            facts.push(fact);
        }
    }
    facts
}
fn parameter(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    let parameters = if n.kind() == "function_expression" {
        n.child_by_field_name("parameters")
    } else {
        descendant(n, "formal_parameter_list")
    };
    parameters.is_some_and(|n| {
        walk(n).into_iter().any(|n| {
            n.kind() == "formal_parameter"
                && n.child_by_field_name("name")
                    .is_some_and(|n| c.text(n) == name)
        })
    })
}
fn pattern(c: &Context<'_>, n: Node<'_>, name: &str, declaration: bool) -> bool {
    walk(n).into_iter().any(|n| match n.kind() {
        "variable_pattern" => children(n)
            .into_iter()
            .rev()
            .find(|n| n.kind() == "identifier")
            .is_some_and(|n| c.text(n) == name),
        "constant_pattern" if declaration => {
            named(n, "identifier").is_some_and(|n| c.text(n) == name)
        }
        _ => false,
    })
}
fn pattern_node(n: Node<'_>) -> Option<Node<'_>> {
    children(n)
        .into_iter()
        .find(|n| n.kind().ends_with("_pattern"))
}
fn local_name(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    match n.kind() {
        "initialized_variable_definition" => n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name),
        "local_function_declaration" => descendant(n, "function_signature")
            .and_then(|n| n.child_by_field_name("name"))
            .is_some_and(|n| c.text(n) == name),
        "pattern_variable_declaration" => {
            pattern_node(n).is_some_and(|n| pattern(c, n, name, true))
        }
        _ => false,
    }
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    local_name(c, n, name).then(|| {
        c.declared(n, name, &["function"])
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL)
    })
}
fn direct(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    std::iter::once(n)
        .chain(children(n))
        .find_map(|n| declaration(c, n, name))
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "for_statement"
        && let Some(parts) = named(n, "for_loop_parts")
    {
        if let Some(b) = named(parts, "local_variable_declaration")
            .filter(|n| n.end_byte() <= call.start_byte())
            .and_then(|n| direct(c, n, name))
        {
            return Some(b);
        }
        if n.child_by_field_name("body")
            .is_some_and(|n| encloses(n, call))
            && (parts
                .child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name)
                || pattern_node(parts).is_some_and(|n| pattern(c, n, name, true)))
        {
            return Some(Resolved::LOCAL);
        }
    }
    if n.kind() == "try_statement" {
        for pair in children(n).windows(2) {
            if pair[0].kind() == "catch_clause"
                && pair[1].kind() == "block"
                && encloses(pair[1], call)
                && descendant(pair[0], "catch_parameters").is_some_and(|n| {
                    children(n)
                        .into_iter()
                        .any(|n| n.kind() == "identifier" && c.text(n) == name)
                })
            {
                return Some(Resolved::LOCAL);
            }
        }
    }
    if n.kind() == "if_statement"
        && pattern_node(n)
            .is_some_and(|p| pattern(c, p, name, false) && call.start_byte() >= p.end_byte())
        && n.child_by_field_name("consequence")
            .is_some_and(|n| call.end_byte() <= n.end_byte())
    {
        return Some(Resolved::LOCAL);
    }
    if matches!(n.kind(), "switch_statement_case" | "switch_expression_case") {
        let patterns: Vec<_> = children(n)
            .into_iter()
            .filter(|n| n.kind().ends_with("_pattern"))
            .collect();
        if patterns.iter().any(|n| pattern(c, *n, name, false))
            && call.start_byte()
                >= patterns
                    .last()
                    .map(|n| n.end_byte())
                    .unwrap_or(n.start_byte())
        {
            return Some(Resolved::LOCAL);
        }
    }
    None
}
fn lexical(c: &Context<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    let mut parent = Some(call);
    while let Some(n) = parent {
        if let Some(b) = control(c, n, call, name) {
            return Some(b);
        }
        if n.kind() == "function_body"
            && n.prev_named_sibling().is_some_and(|n| {
                matches!(n.kind(), "function_signature" | "method_signature")
                    && parameter(c, n, name)
            })
        {
            return Some(Resolved::LOCAL);
        }
        if matches!(
            n.kind(),
            "function_expression" | "method_signature" | "function_signature"
        ) && parameter(c, n, name)
        {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "block" {
            if let Some(b) = children(n)
                .into_iter()
                .take_while(|n| n.end_byte() <= call.start_byte())
                .find_map(|n| direct(c, n, name))
            {
                return Some(b);
            }
        } else if n.kind() == "class_body"
            && children(n)
                .into_iter()
                .filter(|n| n.kind() == "declaration")
                .any(|n| {
                    walk(n).into_iter().any(|n| {
                        n.kind() == "initialized_identifier"
                            && named(n, "identifier").is_some_and(|n| c.text(n) == name)
                    })
                })
        {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "extension_type_declaration"
            && named(n, "representation_declaration")
                .and_then(|n| n.child_by_field_name("name"))
                .is_some_and(|n| c.text(n) == name)
        {
            return Some(Resolved::LOCAL);
        }
        parent = n.parent();
    }
    None
}
fn resolve(c: &Context<'_>, root: Node<'_>, node: Node<'_>, name: Option<&str>) -> Resolved {
    let Some(name) = name.filter(|s| !s.is_empty()) else {
        return Resolved::UNKNOWN;
    };
    if let Some(b) = lexical(c, node, name) {
        return b;
    }
    if children(root)
        .into_iter()
        .filter(|n| n.kind() == "import_or_export" && n.start_byte() <= node.start_byte())
        .any(|n| {
            if let Some(alias) = alias(c, n).filter(|s| !s.is_empty()) {
                alias == name
            } else {
                shown(c, n).is_some_and(|s| s.iter().any(|s| s == name))
            }
        })
    {
        return Resolved::IMPORT;
    }
    let mut targets = c.chunks.iter().filter(|chunk| {
        chunk.name.as_deref() == Some(name)
            && (chunk.kind == "function" || (chunk.kind == "class" && chunk.parent.is_none()))
    });
    match (targets.next(), targets.next()) {
        (Some(chunk), None) => Resolved::target(ChunkRef {
            kind: chunk.kind.clone(),
            name: name.into(),
            location: Location::from_span(&chunk.span),
        }),
        _ => Resolved::UNKNOWN,
    }
}
// The native Dart grammar wraps calls in method_invocation nodes. The TS
// grammar used sibling selectors; render both forms to the same written callee.
fn native_callee<'a>(c: &Context<'_>, n: Node<'a>) -> Option<(String, Node<'a>)> {
    match n.kind() {
        "identifier" | "this" | "super" | "dot_shorthand" => Some((c.text(n).into(), n)),
        "method_invocation" => {
            let (callee, base) = native_callee(c, n.child_by_field_name("function")?)?;
            Some((format!("{callee}()"), base))
        }
        "unconditional_assignable_selector" | "conditional_assignable_selector" => {
            let (mut callee, base) = native_callee(c, n.named_child(0)?)?;
            let member = children(n)
                .into_iter()
                .rev()
                .find(|n| n.kind() == "identifier")?;
            callee.push_str(if c.text(n).contains("?.") { "?." } else { "." });
            callee.push_str(c.text(member));
            Some((callee, base))
        }
        _ => None,
    }
}

pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if n.kind() == "annotation" {
            continue;
        }
        if matches!(
            n.kind(),
            "import_or_export" | "part_directive" | "part_of_directive"
        ) {
            facts.extend(imports(c, n));
        }
        if n.kind() == "method_invocation"
            && let Some((callee, base)) = n
                .child_by_field_name("function")
                .and_then(|n| native_callee(c, n))
        {
            let resolved = resolve(
                c,
                root,
                base,
                (base.kind() == "identifier").then(|| c.text(base)),
            );
            facts.push(c.call(callee, n, resolved, c.owner(n)));
        }
        let nodes = children(n);
        for (index, &base) in nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| matches!(n.kind(), "identifier" | "this" | "super" | "dot_shorthand"))
        {
            let mut callee = c.text(base).to_owned();
            let name = (base.kind() == "identifier").then(|| c.text(base));
            for &selector in nodes
                .iter()
                .skip(index + 1)
                .take_while(|n| n.kind() == "selector")
            {
                if descendant(selector, "argument_part").is_none() {
                    if let Some(member) =
                        descendant(selector, "identifier").filter(|n| !c.text(*n).is_empty())
                    {
                        callee.push_str(
                            if c.text(selector).contains("?.") || c.text(selector).starts_with('?')
                            {
                                "?."
                            } else {
                                "."
                            },
                        );
                        callee.push_str(c.text(member));
                    }
                } else {
                    let resolved = resolve(c, root, base, name);
                    facts.push(Fact {
                        kind: Kind::Call {
                            callee: callee.clone(),
                            binding: resolved.binding,
                            target: resolved.target,
                        },
                        owner: c.owner_range(base.start_byte(), selector.end_byte(), |_| true),
                        location: Location::from_span(
                            &c.lines.span(base.start_byte(), selector.end_byte()),
                        ),
                    });
                    callee.push_str("()");
                }
            }
        }
        if n.kind() == "cascade_section"
            && let Some(name) = named(n, "cascade_selector")
                .and_then(|n| descendant(n, "identifier"))
                .filter(|n| !c.text(*n).is_empty())
            && descendant(n, "argument_part").is_some()
        {
            let mut parent = n.parent();
            while let Some(n) = parent {
                if n.kind() == "initialized_variable_definition" {
                    break;
                }
                parent = n.parent();
            }
            let variable = parent
                .and_then(|n| n.child_by_field_name("name"))
                .map(|n| c.text(n));
            facts.push(c.call(
                format!("{}..{}", variable.unwrap_or(""), c.text(name)),
                n,
                if variable.is_some_and(|s| !s.is_empty()) {
                    Resolved::LOCAL
                } else {
                    Resolved::UNKNOWN
                },
                c.owner(n),
            ));
        }
        stack.extend(nodes.into_iter().rev());
    }
    facts
}
