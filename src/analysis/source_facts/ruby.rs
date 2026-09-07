use super::*;

fn names(c: &Context<'_>, n: Option<Node<'_>>, name: &str, pattern: bool) -> bool {
    let Some(n) = n else { return false };
    if pattern {
        if n.kind() == "identifier" {
            return c.text(n) == name;
        }
        if matches!(
            n.kind(),
            "constant"
                | "scope_resolution"
                | "pin"
                | "alternative_pattern"
                | "string"
                | "integer"
                | "float"
                | "nil"
                | "true"
                | "false"
        ) {
            return false;
        }
        if matches!(n.kind(), "splat_parameter" | "hash_splat_parameter") {
            return names(c, n.child_by_field_name("name"), name, true);
        }
    } else {
        if matches!(
            n.kind(),
            "identifier" | "constant" | "instance_variable" | "class_variable" | "global_variable"
        ) {
            return c.text(n) == name;
        }
        if matches!(
            n.kind(),
            "optional_parameter"
                | "keyword_parameter"
                | "splat_parameter"
                | "hash_splat_parameter"
                | "block_parameter"
                | "destructured_parameter"
        ) && let Some(n) = n.child_by_field_name("name")
        {
            return c.text(n) == name;
        }
    }
    children(n)
        .into_iter()
        .any(|n| names(c, Some(n), name, pattern))
}
fn declaration(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    let kinds: &[&str] = match n.kind() {
        "assignment" if names(c, n.child_by_field_name("left"), name, false) => {
            &["function", "constant"]
        }
        "method" | "singleton_method"
            if n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name) =>
        {
            &["method"]
        }
        "class" | "module"
            if n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name) =>
        {
            &["class", "module"]
        }
        _ => return None,
    };
    Some(
        c.declared(n, name, kinds)
            .map(Resolved::target)
            .unwrap_or(Resolved::LOCAL),
    )
}
fn boundary(n: Node<'_>) -> bool {
    matches!(
        n.kind(),
        "method" | "singleton_method" | "lambda" | "block" | "do_block" | "class" | "module"
    )
}
fn collapse(mut candidates: Vec<Resolved>) -> Option<Resolved> {
    if candidates.len() == 1 {
        candidates.pop()
    } else if candidates.len() > 1 {
        Some(Resolved::LOCAL)
    } else {
        None
    }
}
fn local_assignment(c: &Context<'_>, scope: Node<'_>, name: &str) -> Option<Resolved> {
    let mut stack = children(scope);
    let mut candidates = Vec::new();
    while let Some(n) = stack.pop() {
        if boundary(n) {
            continue;
        }
        if n.kind() == "assignment" && names(c, n.child_by_field_name("left"), name, false) {
            candidates.extend(declaration(c, n, name));
        }
        let lexical = match n.kind() {
            "for" | "in_clause" => names(c, n.child_by_field_name("pattern"), name, true),
            "rescue" => names(c, n.child_by_field_name("variable"), name, false),
            _ => false,
        };
        if lexical {
            candidates.push(Resolved::LOCAL);
        }
        stack.extend(children(n));
    }
    collapse(candidates)
}
fn expression_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "constant" | "instance_variable" | "class_variable" | "global_variable"
        | "self" | "super" => Some(c.text(n)),
        "scope_resolution" | "parenthesized_statements" => {
            n.named_child(0).and_then(|n| expression_root(c, n))
        }
        "call" => n
            .child_by_field_name("receiver")
            .and_then(|n| expression_root(c, n)),
        _ => None,
    }
}
fn resolve(c: &Context<'_>, call: Node<'_>, name: &str) -> Resolved {
    if matches!(name, "self" | "super") || name.starts_with(['@', '$']) {
        return Resolved::LOCAL;
    }
    let mut parent = call.parent();
    while let Some(n) = parent {
        if matches!(
            n.kind(),
            "method" | "singleton_method" | "lambda" | "block" | "do_block"
        ) {
            let parameters = n.child_by_field_name("parameters");
            if names(c, parameters, name, false)
                || (matches!(n.kind(), "block" | "do_block")
                    && parameters.is_none()
                    && name.len() == 2
                    && name.starts_with('_')
                    && matches!(name.as_bytes()[1], b'1'..=b'9'))
            {
                return Resolved::LOCAL;
            }
            if let Some(b) = n
                .child_by_field_name("body")
                .and_then(|n| local_assignment(c, n, name))
            {
                return b;
            }
        }
        if matches!(n.kind(), "body_statement" | "block_body" | "program") {
            if n.kind() == "program"
                && let Some(b) = local_assignment(c, n, name)
            {
                return b;
            }
            let candidates = children(n)
                .into_iter()
                .filter(|n| {
                    matches!(n.kind(), "method" | "singleton_method" | "class" | "module")
                        || n.start_byte() <= call.start_byte()
                })
                .filter_map(|n| declaration(c, n, name))
                .collect();
            if let Some(b) = collapse(candidates) {
                return b;
            }
        }
        parent = n.parent();
    }
    Resolved::UNKNOWN
}
fn loader(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    let method = c.text(n.child_by_field_name("method")?);
    if !matches!(method, "require" | "require_relative" | "load" | "autoload")
        || n.child_by_field_name("receiver").is_some()
        || resolve(c, n, method).binding != Binding::Unknown
    {
        return None;
    }
    let args = n.child_by_field_name("arguments")?;
    let arg = args.named_child(if method == "autoload" { 1 } else { 0 })?;
    if arg.kind() != "string"
        || children(arg)
            .into_iter()
            .any(|n| n.kind() != "string_content")
    {
        return None;
    }
    let value = c.text(arg);
    let source = if value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        ""
    };
    let mut fact = c.import(source.into(), method, n, c.owner(n));
    if method == "autoload"
        && let Kind::Import { local, .. } = &mut fact.kind
    {
        *local = args.named_child(0).map(|n| {
            c.text(n)
                .strip_prefix(':')
                .unwrap_or_else(|| c.text(n))
                .into()
        });
    }
    Some(fact)
}
fn assigned_left(n: Node<'_>) -> bool {
    n.parent()
        .is_some_and(|p| p.kind() == "assignment" && p.child_by_field_name("left") == Some(n))
}
fn call(c: &Context<'_>, n: Node<'_>) -> Option<Fact> {
    if n.kind() == "yield" {
        return Some(c.call("yield".into(), n, Resolved::LOCAL, c.owner(n)));
    }
    let (callee, root) = match n.kind() {
        "call" => {
            let method = n.child_by_field_name("method")?;
            let receiver = n.child_by_field_name("receiver");
            let mut callee = if receiver.is_some() {
                c.source[n.start_byte()..method.end_byte()].to_owned()
            } else {
                c.text(method).into()
            };
            if assigned_left(n) {
                callee.push('=');
            }
            (
                callee,
                receiver
                    .and_then(|n| expression_root(c, n))
                    .or_else(|| Some(c.text(method))),
            )
        }
        "binary" => {
            let left = n.child_by_field_name("left")?;
            let operator = n.children(&mut n.walk()).find(|n| {
                !n.is_named()
                    && matches!(
                        n.kind(),
                        "+" | "-"
                            | "*"
                            | "/"
                            | "%"
                            | "**"
                            | "=="
                            | "!="
                            | "<"
                            | "<="
                            | ">"
                            | ">="
                            | "<=>"
                            | "=~"
                            | "!~"
                            | "&"
                            | "|"
                            | "^"
                            | "<<"
                            | ">>"
                    )
            })?;
            (
                format!("{}.{}", c.text(left), operator.kind()),
                expression_root(c, left),
            )
        }
        "unary" => {
            let operand = n.child_by_field_name("operand")?;
            let operator = n
                .children(&mut n.walk())
                .find(|n| !n.is_named() && matches!(n.kind(), "+" | "-" | "~"))?;
            (
                format!("{}.{}@", c.text(operand), operator.kind()),
                expression_root(c, operand),
            )
        }
        "element_reference" => {
            if assigned_left(n) {
                return None;
            }
            let object = n.child_by_field_name("object")?;
            (format!("{}.[]", c.text(object)), expression_root(c, object))
        }
        "assignment" => {
            let left = n
                .child_by_field_name("left")
                .filter(|n| n.kind() == "element_reference")?;
            let object = left.child_by_field_name("object")?;
            (
                format!("{}.[]=", c.text(object)),
                expression_root(c, object),
            )
        }
        _ => return None,
    };
    let resolved = resolve(c, n, root.unwrap_or(&callee));
    Some(c.call(callee, n, resolved, c.owner(n)))
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    walk(root)
        .into_iter()
        .filter_map(|n| {
            if n.kind() == "call" {
                loader(c, n).or_else(|| call(c, n))
            } else {
                call(c, n)
            }
        })
        .collect()
}
