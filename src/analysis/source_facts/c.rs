use super::*;

fn declarator_name<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    if matches!(
        n.kind(),
        "identifier" | "type_identifier" | "field_identifier"
    ) {
        return Some(c.text(n));
    }
    if let Some(d) = n.child_by_field_name("declarator") {
        return declarator_name(c, d);
    }
    if n.kind() == "parenthesized_declarator" {
        return n.named_child(0).and_then(|n| declarator_name(c, n));
    }
    None
}
fn function_declarator(n: Node<'_>) -> bool {
    let mut current = Some(n);
    let mut last = "";
    while let Some(n) = current {
        if matches!(
            n.kind(),
            "function_declarator" | "pointer_declarator" | "array_declarator"
        ) {
            last = n.kind();
        }
        current = if n.kind() == "parenthesized_declarator" {
            n.named_child(0)
        } else {
            n.child_by_field_name("declarator")
        };
    }
    last == "function_declarator"
}
fn parameter(c: &Context<'_>, n: Node<'_>, name: &str) -> bool {
    let mut current = n.child_by_field_name("declarator");
    while let Some(n) = current {
        if n.kind() == "function_declarator" {
            return n.child_by_field_name("parameters").is_some_and(|n| {
                children(n).into_iter().any(|n| {
                    n.kind() == "parameter_declaration"
                        && n.child_by_field_name("declarator")
                            .and_then(|n| declarator_name(c, n))
                            == Some(name)
                })
            });
        }
        current = if n.kind() == "parenthesized_declarator" {
            n.named_child(0)
        } else {
            n.child_by_field_name("declarator")
        };
    }
    false
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let bound = match n.kind() {
        "function_definition" => {
            n.child_by_field_name("declarator")
                .and_then(|n| declarator_name(c, n))
                == Some(name)
        }
        "declaration" => {
            let d = n
                .children_by_field_name("declarator", &mut n.walk())
                .find(|n| declarator_name(c, *n) == Some(name))?;
            if !function_declarator(d) {
                return Some(Resolved::LOCAL);
            }
            true
        }
        "preproc_def" | "preproc_function_def" => n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name),
        _ => false,
    };
    bound.then(|| {
        c.declared(n, name, &["function", "macro"])
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL)
    })
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" => Some(c.text(n)),
        "field_expression" | "pointer_expression" | "subscript_expression" => n
            .child_by_field_name("argument")
            .and_then(|n| expression_root(c, n)),
        "parenthesized_expression" => n.named_child(0).and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn assignment(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let expression = if n.kind() == "expression_statement" {
        n.named_child(0)?
    } else {
        n
    };
    (expression.kind() == "assignment_expression"
        && expression
            .child_by_field_name("left")
            .is_some_and(|n| n.kind() == "identifier" && c.text(n) == name))
    .then_some(Resolved::LOCAL)
}
fn call_owner(c: &Context<'_>, call: Node<'_>) -> Option<ChunkRef> {
    let owner = c.owner(call)?;
    if owner.kind != "variable" {
        return Some(owner);
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "declaration" {
            return Some(owner);
        }
        if n.kind() == "function_definition" {
            break;
        }
        parent = n.parent();
    }
    c.owner_where(call, |chunk| {
        chunk.kind != owner.kind
            || chunk.name.as_deref() != Some(owner.name.as_str())
            || chunk.span.start != owner.location.start_offset
            || chunk.span.end != owner.location.end_offset
    })
}
fn scope(c: &Context<'_>, scope: Node<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    let mut bindings: Vec<(Node<'_>, Resolved)> = Vec::new();
    for n in children(scope).into_iter().filter(|n| {
        (n.end_byte() <= call.start_byte()
            || (n.kind() == "function_definition"
                && n.child_by_field_name("body")
                    .is_some_and(|n| encloses(n, call))))
            && matches!(
                n.kind(),
                "function_definition"
                    | "declaration"
                    | "preproc_def"
                    | "preproc_function_def"
                    | "preproc_call"
                    | "expression_statement"
            )
    }) {
        if n.kind() == "preproc_call"
            && n.child_by_field_name("directive")
                .is_some_and(|n| c.text(n) == "#undef")
            && n.child_by_field_name("argument")
                .is_some_and(|n| c.text(n).trim() == name)
        {
            bindings.retain(|(n, _)| !matches!(n.kind(), "preproc_def" | "preproc_function_def"));
            continue;
        }
        if let Some(b) = declaration(c, n, name).or_else(|| assignment(c, n, name)) {
            bindings.push((n, b));
        }
    }
    bindings
        .iter()
        .find(|(n, _)| n.kind() == "function_definition")
        .or_else(|| bindings.last())
        .map(|(_, b)| b.clone())
}
fn resolve(c: &Context<'_>, call: Node<'_>, function: Node<'_>) -> Resolved {
    let Some(name) = expression_root(c, function) else {
        return Resolved::UNKNOWN;
    };
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "for_statement"
            && let Some(b) = n
                .child_by_field_name("initializer")
                .filter(|n| !encloses(*n, call))
                .and_then(|n| declaration(c, n, name))
        {
            return b;
        }
        if n.kind() == "function_definition" && parameter(c, n, name) {
            return Resolved::LOCAL;
        }
        if matches!(
            n.kind(),
            "compound_statement"
                | "translation_unit"
                | "preproc_if"
                | "preproc_ifdef"
                | "preproc_else"
                | "preproc_elif"
        ) && let Some(b) = scope(c, n, call, name)
        {
            return b;
        }
        parent = if matches!(n.kind(), "preproc_else" | "preproc_elif") {
            n.parent().and_then(|n| n.parent()).or_else(|| n.parent())
        } else {
            n.parent()
        };
    }
    Resolved::UNKNOWN
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for n in walk(root) {
        if n.kind() == "preproc_include" {
            if let Some(path) = n.child_by_field_name("path") {
                let mut fact = c.import(c.text(path).into(), "", n, c.owner(n));
                if let Kind::Import { imported, .. } = &mut fact.kind {
                    *imported = None;
                }
                facts.push(fact);
            }
        } else if n.kind() == "call_expression"
            && let Some(function) = n.child_by_field_name("function")
        {
            facts.push(c.call(
                c.text(function).into(),
                n,
                resolve(c, n, function),
                call_owner(c, n),
            ));
        }
    }
    facts
}
