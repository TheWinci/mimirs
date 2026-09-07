use super::*;

fn imported_name(node: Node<'_>) -> Node<'_> {
    if node.kind() == "aliased_import" {
        node.child_by_field_name("name").unwrap_or(node)
    } else {
        node
    }
}
fn import_binding<'a>(c: &'a Context<'_>, node: Node<'_>, module: bool) -> &'a str {
    if let Some(alias) = node.child_by_field_name("alias") {
        return c.text(alias);
    }
    let name = c.text(imported_name(node));
    if module {
        name.split('.').next().unwrap_or(name)
    } else {
        name
    }
}
fn contains(node: Option<Node<'_>>, target: Node<'_>) -> bool {
    node.is_some_and(|n| encloses(n, target))
}
fn type_only(c: &Context<'_>, node: Node<'_>) -> bool {
    let mut parent = node.parent();
    while let Some(p) = parent {
        if p.kind() == "if_statement"
            && p.child_by_field_name("condition")
                .is_some_and(|n| matches!(c.text(n), "TYPE_CHECKING" | "typing.TYPE_CHECKING"))
            && contains(p.child_by_field_name("consequence"), node)
        {
            return true;
        }
        parent = p.parent();
    }
    false
}
fn binds(c: &Context<'_>, node: Option<Node<'_>>, name: &str, pattern: bool) -> bool {
    let Some(n) = node else { return false };
    if pattern {
        if n.kind() == "dotted_name" {
            let ids: Vec<_> = children(n)
                .into_iter()
                .filter(|n| n.kind() == "identifier")
                .collect();
            return ids.len() == 1 && name != "_" && c.text(ids[0]) == name;
        }
        if matches!(n.kind(), "class_pattern" | "keyword_pattern") {
            return children(n)
                .into_iter()
                .skip(1)
                .any(|n| binds(c, Some(n), name, true));
        }
        if n.kind() == "identifier" {
            return name != "_" && c.text(n) == name;
        }
    } else {
        if n.kind() == "identifier" {
            return c.text(n) == name;
        }
        if matches!(n.kind(), "attribute" | "subscript") {
            return false;
        }
        if matches!(
            n.kind(),
            "default_parameter" | "typed_parameter" | "typed_default_parameter"
        ) {
            return binds(
                c,
                n.child_by_field_name("name").or_else(|| n.named_child(0)),
                name,
                false,
            );
        }
    }
    children(n)
        .into_iter()
        .any(|n| binds(c, Some(n), name, pattern))
}
fn definition(n: Node<'_>) -> Option<Node<'_>> {
    if matches!(n.kind(), "function_definition" | "class_definition") {
        Some(n)
    } else if n.kind() == "decorated_definition" {
        children(n)
            .into_iter()
            .find(|n| matches!(n.kind(), "function_definition" | "class_definition"))
    } else {
        None
    }
}
fn comprehension(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "list_comprehension"
            | "set_comprehension"
            | "dictionary_comprehension"
            | "generator_expression"
    )
}
fn direct(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if matches!(n.kind(), "import_statement" | "import_from_statement") {
        return children(n)
            .into_iter()
            .filter(|b| {
                Some(*b) != n.child_by_field_name("module_name") && b.kind() != "wildcard_import"
            })
            .any(|b| import_binding(c, b, n.kind() == "import_statement") == name)
            .then_some(Resolved::IMPORT);
    }
    if let Some(d) = definition(n) {
        if !d
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
        {
            return None;
        }
        let kinds: &[&str] = if d.kind() == "class_definition" {
            &["class"]
        } else {
            &["function", "method"]
        };
        return Some(
            c.declared(d, name, kinds)
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        );
    }
    let binding = match n.kind() {
        "assignment" | "augmented_assignment" | "named_expression" => binds(
            c,
            n.child_by_field_name("left")
                .or_else(|| n.child_by_field_name("name"))
                .or_else(|| n.named_child(0)),
            name,
            false,
        ),
        "for_statement" => binds(c, n.child_by_field_name("left"), name, false),
        "with_item" => binds(
            c,
            named(n, "as_pattern").and_then(|n| n.child_by_field_name("alias")),
            name,
            false,
        ),
        "except_clause" => binds(
            c,
            n.child_by_field_name("value")
                .filter(|n| n.kind() == "as_pattern")
                .and_then(|n| n.child_by_field_name("alias")),
            name,
            false,
        ),
        "case_clause" => binds(c, named(n, "case_pattern"), name, true),
        "delete_statement" => binds(c, Some(n), name, false),
        _ => false,
    };
    binding.then_some(Resolved::LOCAL)
}
fn collapse(mut bindings: Vec<Resolved>) -> Option<Resolved> {
    if bindings.is_empty() {
        None
    } else if bindings.iter().all(|b| b.binding == Binding::Import) {
        Some(Resolved::IMPORT)
    } else if bindings.len() == 1 && bindings[0].binding == Binding::SourceChunk {
        bindings.pop()
    } else {
        Some(Resolved::LOCAL)
    }
}
fn scope_bindings(
    c: &Context<'_>,
    scope: Node<'_>,
    name: &str,
    before: Option<usize>,
) -> Vec<Resolved> {
    let body = if scope.kind() == "module" {
        Some(scope)
    } else {
        scope.child_by_field_name("body")
    };
    let Some(body) = body else { return Vec::new() };
    let mut result = Vec::new();
    let mut stack: Vec<_> = children(body).into_iter().rev().collect();
    while let Some(n) = stack.pop() {
        if before.is_some_and(|offset| n.start_byte() >= offset) {
            continue;
        }
        if definition(n).is_some() {
            result.extend(direct(c, n, name));
            continue;
        }
        if n.kind() == "lambda" {
            continue;
        }
        if comprehension(n) {
            let mut inner: Vec<_> = children(n).into_iter().rev().collect();
            while let Some(n) = inner.pop() {
                if n.kind() == "lambda" {
                    continue;
                }
                if n.kind() == "named_expression" {
                    result.extend(direct(c, n, name));
                }
                inner.extend(children(n).into_iter().rev());
            }
            continue;
        }
        result.extend(direct(c, n, name));
        stack.extend(children(n).into_iter().rev());
    }
    result
}
fn directive(c: &Context<'_>, function: Node<'_>, name: &str) -> Option<bool> {
    let body = function.child_by_field_name("body")?;
    let mut stack: Vec<_> = children(body).into_iter().rev().collect();
    while let Some(n) = stack.pop() {
        if definition(n).is_some() || n.kind() == "lambda" || comprehension(n) {
            continue;
        }
        if matches!(n.kind(), "global_statement" | "nonlocal_statement")
            && children(n)
                .into_iter()
                .any(|n| n.kind() == "identifier" && c.text(n) == name)
        {
            return Some(n.kind() == "global_statement");
        }
        stack.extend(children(n).into_iter().rev());
    }
    None
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if n.kind() == "identifier" {
        Some(c.text(n))
    } else if matches!(n.kind(), "attribute" | "subscript") {
        n.child_by_field_name("object")
            .or_else(|| n.named_child(0))
            .and_then(|n| callee_root(c, n))
    } else {
        None
    }
}
fn resolve(c: &Context<'_>, call: Node<'_>, callee: Node<'_>) -> Resolved {
    let Some(name) = callee_root(c, callee) else {
        return Resolved::UNKNOWN;
    };
    let mut current = call.parent();
    let mut crossed_function = false;
    let mut global_only = false;
    while let Some(n) = current {
        if comprehension(n) {
            let nodes = children(n);
            if let Some(index) = nodes.iter().position(|n| encloses(*n, call)) {
                let visible = if index == 0 {
                    &nodes[..]
                } else {
                    &nodes[..index]
                };
                if visible.iter().any(|n| {
                    n.kind() == "for_in_clause"
                        && binds(c, n.child_by_field_name("left"), name, false)
                }) {
                    return Resolved::LOCAL;
                }
            }
        }
        if n.kind() == "lambda" && contains(n.child_by_field_name("body"), call) {
            if binds(c, n.child_by_field_name("parameters"), name, false) {
                return Resolved::LOCAL;
            }
            if let Some(binding) = collapse(scope_bindings(c, n, name, None)) {
                return binding;
            }
            crossed_function = true;
        }
        if n.kind() == "function_definition" {
            if !contains(n.child_by_field_name("body"), call) {
                current = n.parent();
                continue;
            }
            let bindings = scope_bindings(c, n, name, None);
            if let Some(global) = directive(c, n, name) {
                if let Some(b) = collapse(bindings) {
                    return b;
                }
                if global {
                    global_only = true;
                }
                crossed_function = true;
                current = n.parent();
                continue;
            }
            if !global_only {
                if binds(c, n.child_by_field_name("parameters"), name, false) {
                    return Resolved::LOCAL;
                }
                if let Some(b) = collapse(bindings) {
                    return b;
                }
            }
            crossed_function = true;
        }
        if ((n.kind() == "class_definition"
            && !crossed_function
            && !global_only
            && contains(n.child_by_field_name("body"), call))
            || n.kind() == "module")
            && let Some(b) = collapse(scope_bindings(c, n, name, Some(call.start_byte())))
        {
            return b;
        }
        current = n.parent();
    }
    Resolved::UNKNOWN
}
fn call_owner(c: &Context<'_>, call: Node<'_>) -> Option<ChunkRef> {
    let owner = c.owner(call)?;
    let mut parent = call.parent();
    while let Some(n) = parent {
        if let Some(d) = definition(n)
            && d.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == owner.name)
        {
            if !contains(d.child_by_field_name("body"), call) {
                return c.owner_where(call, |chunk| {
                    chunk.span.start != owner.location.start_offset
                        || chunk.span.end != owner.location.end_offset
                        || chunk.kind != owner.kind
                        || chunk.name.as_deref() != Some(owner.name.as_str())
                });
            }
            break;
        }
        parent = n.parent();
    }
    Some(owner)
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if matches!(n.kind(), "import_statement" | "import_from_statement") {
            let module = n.child_by_field_name("module_name");
            if n.kind() == "import_from_statement" && module.is_none() {
                continue;
            }
            for binding in children(n).into_iter().filter(|n| Some(*n) != module) {
                let wildcard = binding.kind() == "wildcard_import";
                let source = module
                    .map(|n| c.text(n))
                    .unwrap_or_else(|| c.text(imported_name(binding)));
                let imported = if module.is_none() || wildcard {
                    "*"
                } else {
                    c.text(imported_name(binding))
                };
                let mut fact = c.import(source.into(), imported, binding, c.owner(n));
                if let Kind::Import {
                    local,
                    type_only: only,
                    ..
                } = &mut fact.kind
                {
                    *local =
                        (!wildcard).then(|| import_binding(c, binding, module.is_none()).into());
                    *only = type_only(c, n);
                }
                facts.push(fact);
            }
        } else if n.kind() == "call"
            && let Some(callee) = n.child_by_field_name("function")
        {
            facts.push(c.call(
                c.text(callee).into(),
                n,
                resolve(c, n, callee),
                call_owner(c, n),
            ));
        }
    }
    facts
}
