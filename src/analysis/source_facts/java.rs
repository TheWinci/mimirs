use super::*;

fn name_is(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    n.child_by_field_name("name")
        .is_some_and(|n| c.text(n) == name)
}
fn type_decl(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_declaration"
            | "interface_declaration"
            | "record_declaration"
            | "enum_declaration"
            | "annotation_type_declaration"
    )
}
fn type_body(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "class_body" | "interface_body" | "enum_body" | "annotation_type_body"
    )
}
fn java_import(c: &Context<'_>, n: Node<'_>) -> Option<(String, String, Option<String>, bool)> {
    let path = c.text(
        children(n)
            .into_iter()
            .find(|n| matches!(n.kind(), "scoped_identifier" | "identifier"))?,
    );
    let is_static = n.children(&mut n.walk()).any(|n| n.kind() == "static");
    if named(n, "asterisk").is_some() {
        return Some((path.into(), "*".into(), None, is_static));
    }
    let last = path.rsplit('.').next().unwrap_or(path);
    if !is_static {
        return Some((path.into(), "*".into(), Some(last.into()), false));
    }
    Some((
        path.get(..path.len().saturating_sub(last.len() + 1))
            .unwrap_or("")
            .into(),
        last.into(),
        Some(last.into()),
        true,
    ))
}
fn parameter(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(n) = n else { return false };
    match n.kind() {
        "identifier" => c.text(n) == name,
        "formal_parameter" | "spread_parameter" | "receiver_parameter" => n
            .child_by_field_name("name")
            .map(|n| c.text(n) == name)
            .unwrap_or(n.kind() == "receiver_parameter" && name == "this"),
        "formal_parameters" | "inferred_parameters" => {
            children(n).into_iter().any(|n| parameter(c, Some(n), name))
        }
        _ => false,
    }
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if matches!(n.kind(), "local_variable_declaration" | "field_declaration") {
        let d = children(n)
            .into_iter()
            .find(|n| n.kind() == "variable_declarator" && name_is(c, *n, name))?;
        return Some(if n.kind() == "field_declaration" {
            Resolved::LOCAL
        } else {
            c.declared(d, name, &["function"])
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL)
        });
    }
    if type_decl(n) && name_is(c, n, name) {
        return Some(
            c.declared(
                n,
                name,
                &["class", "interface", "record", "enum", "annotation_type"],
            )
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
        );
    }
    if n.kind() == "import_declaration"
        && java_import(c, n).is_some_and(|(_, _, local, _)| local.as_deref() == Some(name))
    {
        return Some(Resolved::IMPORT);
    }
    None
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "type_identifier" | "this" | "super" => Some(c.text(n)),
        "scoped_identifier" | "scoped_type_identifier" => n
            .child_by_field_name("scope")
            .and_then(|n| expression_root(c, n)),
        "field_access" => n
            .child_by_field_name("object")
            .and_then(|n| expression_root(c, n)),
        "array_access" => n
            .child_by_field_name("array")
            .and_then(|n| expression_root(c, n)),
        "parenthesized_expression" | "generic_type" => {
            n.named_child(0).and_then(|n| expression_root(c, n))
        }
        _ => None,
    }
}
fn contains(n: Option<Node<'_>>, call: Node<'_>) -> bool {
    n.is_some_and(|n| encloses(n, call))
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    let Some(root) = n else { return false };
    root.child_by_field_name("name")
        .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name)
        || walk(root).into_iter().skip(1).any(|n| {
            if n.kind() == "instanceof_expression" {
                n.child_by_field_name("name")
                    .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name)
            } else if matches!(n.kind(), "type_pattern" | "record_pattern_component") {
                children(n)
                    .into_iter()
                    .rev()
                    .find(|n| n.kind() == "identifier")
                    .is_some_and(|n| c.text(n) == name)
            } else {
                false
            }
        })
}
fn control(c: &Context<'_>, n: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "for_statement"
        && let Some(b) = n
            .child_by_field_name("init")
            .filter(|n| n.end_byte() <= call.start_byte())
            .and_then(|n| declaration(c, n, name))
    {
        return Some(b);
    }
    let bound = match n.kind() {
        "enhanced_for_statement" => {
            contains(n.child_by_field_name("body"), call) && name_is(c, n, name)
        }
        "catch_clause" => {
            contains(n.child_by_field_name("body"), call)
                && named(n, "catch_formal_parameter").is_some_and(|n| name_is(c, n, name))
        }
        "try_with_resources_statement" => {
            contains(n.child_by_field_name("body"), call)
                && n.child_by_field_name("resources")
                    .is_some_and(|n| children(n).into_iter().any(|n| name_is(c, n, name)))
        }
        "if_statement" | "while_statement" => {
            pattern(c, n.child_by_field_name("condition"), name)
                && contains(
                    n.child_by_field_name(if n.kind() == "if_statement" {
                        "consequence"
                    } else {
                        "body"
                    }),
                    call,
                )
        }
        "switch_rule" | "switch_block_statement_group" => named(n, "switch_label")
            .is_some_and(|n| n.end_byte() <= call.start_byte() && pattern(c, Some(n), name)),
        _ => false,
    };
    bound.then_some(Resolved::LOCAL)
}
fn enclosing_parameter(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    if matches!(
        n.kind(),
        "method_declaration"
            | "constructor_declaration"
            | "compact_constructor_declaration"
            | "lambda_expression"
    ) {
        if parameter(c, n.child_by_field_name("parameters"), name) {
            return true;
        }
        if n.kind() == "compact_constructor_declaration" {
            return n.parent().and_then(|n| n.parent()).is_some_and(|n| {
                n.kind() == "record_declaration"
                    && parameter(c, n.child_by_field_name("parameters"), name)
            });
        }
    }
    false
}
fn resolve_value(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "this" | "super") {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if let Some(b) = control(c, n, call, name) {
            return b;
        }
        if enclosing_parameter(c, n, name) {
            return Resolved::LOCAL;
        }
        if matches!(n.kind(), "block" | "constructor_body") {
            if let Some(b) = children(n)
                .into_iter()
                .rev()
                .filter(|n| n.end_byte() <= call.start_byte())
                .find_map(|n| declaration(c, n, name))
            {
                return b;
            }
        } else if (type_body(n) || n.kind() == "program")
            && let Some(b) = children(n)
                .into_iter()
                .find_map(|n| declaration(c, n, name))
        {
            return b;
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn resolve_method(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if type_body(n) {
            let decls: Vec<_> = children(n)
                .into_iter()
                .filter(|n| n.kind() == "method_declaration" && name_is(c, *n, name))
                .collect();
            if decls.len() == 1 {
                return c
                    .declared(decls[0], name, &["method"])
                    .map(Resolved::target)
                    .unwrap_or(Resolved::LOCAL);
            }
            if decls.len() > 1 {
                return Resolved::LOCAL;
            }
        }
        if n.kind() == "program"
            && children(n)
                .into_iter()
                .filter(|n| n.kind() == "import_declaration")
                .any(|n| {
                    java_import(c, n).is_some_and(|(_, _, local, is_static)| {
                        is_static && local.as_deref() == Some(name)
                    })
                })
        {
            return Resolved::IMPORT;
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "import_declaration" {
            if let Some((source, imported, alias, is_static)) = java_import(c, n) {
                let mut fact = c.import(source, &imported, n, c.owner(n));
                if let Kind::Import {
                    local,
                    is_static: flag,
                    ..
                } = &mut fact.kind
                {
                    *local = alias;
                    *flag = is_static;
                }
                facts.push(fact);
            }
        } else if n.kind() == "requires_module_directive" {
            if let Some(module) = n.child_by_field_name("module") {
                let mut fact = c.import(c.text(module).into(), "module", n, c.owner(n));
                let modifiers: Vec<_> = c
                    .text(n)
                    .split_whitespace()
                    .skip(1)
                    .take_while(|s| matches!(*s, "static" | "transitive"))
                    .collect();
                if let Kind::Import {
                    type_only,
                    is_static,
                    global,
                    ..
                } = &mut fact.kind
                {
                    *is_static = modifiers.contains(&"static");
                    *type_only = *is_static;
                    *global = modifiers.contains(&"transitive");
                }
                facts.push(fact);
            }
        } else {
            let (callee, resolved) = match n.kind() {
                "method_invocation" => {
                    let Some(name) = n.child_by_field_name("name") else {
                        continue;
                    };
                    let object = n.child_by_field_name("object");
                    let prefix = object
                        .map(|n| format!("{}.", c.text(n)))
                        .unwrap_or_default();
                    let args = n
                        .child_by_field_name("type_arguments")
                        .map(|n| c.text(n))
                        .unwrap_or("");
                    let resolved = if let Some(object) = object {
                        expression_root(c, object)
                            .map(|name| resolve_value(c, n, name))
                            .unwrap_or(Resolved::UNKNOWN)
                    } else {
                        resolve_method(c, n, c.text(name))
                    };
                    (format!("{prefix}{args}{}", c.text(name)), resolved)
                }
                "object_creation_expression" => {
                    let Some(t) = n.child_by_field_name("type") else {
                        continue;
                    };
                    (
                        c.text(t).into(),
                        expression_root(c, t)
                            .map(|name| resolve_value(c, n, name))
                            .unwrap_or(Resolved::UNKNOWN),
                    )
                }
                "explicit_constructor_invocation" => {
                    let Some(t) = n.child_by_field_name("constructor") else {
                        continue;
                    };
                    (
                        c.text(t).into(),
                        if matches!(c.text(t), "this" | "super") {
                            Resolved::LOCAL
                        } else {
                            Resolved::UNKNOWN
                        },
                    )
                }
                _ => continue,
            };
            if !callee.is_empty() {
                facts.push(c.call(callee, n, resolved, c.owner(n)));
            }
        }
    }
    facts
}
