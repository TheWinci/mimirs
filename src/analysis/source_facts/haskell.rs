use super::*;
use std::collections::{HashMap, HashSet};

fn token(n: Node<'_>, kind: &str) -> bool {
    n.children(&mut n.walk()).any(|n| n.kind() == kind)
}
fn unparen(s: &str) -> &str {
    s.strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(s)
}
fn imported<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<(String, Node<'a>)> {
    let mut names = Vec::new();
    if let Some(name) = n
        .child_by_field_name("variable")
        .or_else(|| n.child_by_field_name("type"))
        .or_else(|| n.child_by_field_name("prefix_id"))
        .or_else(|| n.named_child(0))
    {
        let text = unparen(c.text(name));
        if !text.is_empty() {
            names.push((text.into(), n));
        }
    }
    if let Some(list) = named(n, "children") {
        names.extend(
            children(list)
                .into_iter()
                .filter(|n| unparen(c.text(*n)) != "..")
                .map(|n| (unparen(c.text(n)).into(), n)),
        );
    }
    names
}
fn import_names<'a>(c: &Context<'_>, n: Node<'a>) -> Vec<(String, Node<'a>)> {
    n.child_by_field_name("names")
        .map(|list| {
            children(list)
                .into_iter()
                .filter(|n| n.kind() == "import_name")
                .flat_map(|n| imported(c, n))
                .collect()
        })
        .unwrap_or_default()
}
fn imports(c: &Context<'_>, n: Node<'_>) -> Vec<Fact> {
    let Some(source) = n.child_by_field_name("module").map(|n| c.text(n)) else {
        return Vec::new();
    };
    let qualified = token(n, "qualified");
    let hiding = token(n, "hiding");
    let make = |name: &str, alias, evidence| {
        let mut f = c.import(source.into(), name, evidence, c.owner(n));
        if let Kind::Import { local, .. } = &mut f.kind {
            *local = alias;
        }
        f
    };
    let names = import_names(c, n);
    let mut facts = Vec::new();
    if qualified {
        let alias = n
            .child_by_field_name("alias")
            .map(|n| c.text(n))
            .unwrap_or_else(|| source.rsplit('.').next().unwrap_or(source));
        facts.push(make("*", Some(alias.into()), n));
    } else if n
        .child_by_field_name("names")
        .is_none_or(|n| !children(n).into_iter().any(|n| n.kind() == "import_name"))
    {
        return vec![make("*", None, n)];
    }
    for (name, evidence) in names {
        facts.push(make(
            &format!(
                "{}{}{name}",
                if qualified { "qualified " } else { "" },
                if hiding { "hiding " } else { "" }
            ),
            if hiding || qualified {
                None
            } else {
                Some(name)
            },
            evidence,
        ));
    }
    facts
}
fn pattern(c: &Context<'_>, n: Option<Node<'_>>, name: &str) -> bool {
    n.is_some_and(|n| {
        if n.kind() == "variable" {
            c.text(n) == name
        } else {
            children(n).into_iter().any(|n| pattern(c, Some(n), name))
        }
    })
}
fn chunk_ref(chunk: &Chunk) -> ChunkRef {
    ChunkRef {
        kind: chunk.kind.clone(),
        name: chunk.name.clone().unwrap_or_default(),
        location: Location::from_span(&chunk.span),
    }
}
fn targets(c: &Context<'_>, name: &str, function_only: bool) -> Vec<ChunkRef> {
    c.chunks
        .iter()
        .filter(|chunk| {
            chunk.parent.is_none()
                && chunk.name.as_deref() == Some(name)
                && (chunk.kind == "function" || (!function_only && chunk.kind == "type"))
        })
        .map(chunk_ref)
        .collect()
}
fn local(c: &Context<'_>, n: Node<'_>, name: &str) -> Option<Resolved> {
    if n.kind() == "function"
        && n.child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
    {
        return Some(
            c.declared(n, name, &["function"])
                .map(Resolved::target)
                .unwrap_or(Resolved::LOCAL),
        );
    }
    (n.kind() == "bind"
        && (n
            .child_by_field_name("name")
            .is_some_and(|n| c.text(n) == name)
            || pattern(c, n.child_by_field_name("pattern"), name)))
    .then_some(Resolved::LOCAL)
}
fn lexical(c: &Context<'_>, call: Node<'_>, name: &str) -> Option<Resolved> {
    let mut parent = call.parent();
    while let Some(n) = parent {
        if n.kind() == "function" {
            if pattern(c, n.child_by_field_name("patterns"), name) {
                return Some(Resolved::LOCAL);
            }
            if n.child_by_field_name("name")
                .is_some_and(|n| c.text(n) == name)
            {
                let global = targets(c, name, true);
                if global.len() > 1 {
                    return Some(Resolved::UNKNOWN);
                }
                if let Some(t) = global
                    .first()
                    .cloned()
                    .or_else(|| c.owner(n))
                    .filter(|t| t.kind == "function" && t.name == name)
                {
                    return Some(Resolved::target(t));
                }
            }
            if let Some(b) = n
                .child_by_field_name("binds")
                .and_then(|n| children(n).into_iter().find_map(|n| local(c, n, name)))
            {
                return Some(b);
            }
        }
        if n.kind() == "lambda" && pattern(c, n.child_by_field_name("patterns"), name) {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "alternative"
            && n.named_child(0)
                .is_some_and(|n| n.end_byte() <= call.start_byte() && pattern(c, Some(n), name))
        {
            return Some(Resolved::LOCAL);
        }
        if matches!(n.kind(), "let_in" | "where")
            && let Some(b) = children(n)
                .into_iter()
                .filter(|n| n.kind() == "local_binds")
                .flat_map(children)
                .find_map(|n| local(c, n, name))
        {
            return Some(b);
        }
        if n.kind() == "do"
            && children(n)
                .into_iter()
                .take_while(|n| n.end_byte() <= call.start_byte())
                .any(|n| n.kind() == "bind" && pattern(c, n.child_by_field_name("pattern"), name))
        {
            return Some(Resolved::LOCAL);
        }
        if n.kind() == "list_comprehension" {
            let in_result = n.named_child(0).is_some_and(|n| encloses(n, call));
            if let Some(qualifiers) = named(n, "qualifiers") {
                for q in children(qualifiers)
                    .into_iter()
                    .take_while(|n| in_result || n.end_byte() <= call.start_byte())
                {
                    let bound = match q.kind() {
                        "generator" => pattern(c, q.child_by_field_name("pattern"), name),
                        "let" => children(q).into_iter().flat_map(children).any(|n| {
                            n.kind() == "bind"
                                && pattern(
                                    c,
                                    n.child_by_field_name("pattern")
                                        .or_else(|| n.child_by_field_name("name")),
                                    name,
                                )
                        }),
                        _ => false,
                    };
                    if bound {
                        return Some(Resolved::LOCAL);
                    }
                }
            }
        }
        parent = n.parent();
    }
    None
}
fn inside_pattern(n: Node<'_>) -> bool {
    let mut parent = n.parent();
    while let Some(p) = parent {
        if matches!(p.kind(), "match" | "function") {
            break;
        }
        if matches!(p.kind(), "patterns" | "pattern") {
            return true;
        }
        if p.kind() == "alternative" {
            return p.named_child(0).is_some_and(|p| encloses(p, n));
        }
        parent = p.parent();
    }
    false
}
fn callee(n: Node<'_>) -> Option<Node<'_>> {
    let mut current = n.child_by_field_name("function");
    while let Some(n) = current {
        if n.kind() != "apply" {
            return Some(n);
        }
        current = n.child_by_field_name("function");
    }
    None
}
fn callee_root<'a>(c: &'a Context<'_>, n: Node<'_>) -> Option<&'a str> {
    match n.kind() {
        "variable" | "constructor" => Some(c.text(n)),
        "qualified" => c.text(n).split('.').next(),
        _ => children(n).into_iter().find_map(|n| callee_root(c, n)),
    }
}
pub(super) fn extract(c: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut imported_roots = HashSet::new();
    let mut declarations: HashMap<String, Vec<ChunkRef>> = HashMap::new();
    let nodes = walk(root);
    for &n in &nodes {
        if n.kind() == "import" {
            if token(n, "qualified") {
                if let Some(source) = n.child_by_field_name("module").map(|n| c.text(n)) {
                    imported_roots.insert(
                        n.child_by_field_name("alias")
                            .map(|n| c.text(n))
                            .unwrap_or_else(|| source.rsplit('.').next().unwrap_or(source))
                            .to_owned(),
                    );
                }
            } else if !token(n, "hiding") {
                imported_roots.extend(import_names(c, n).into_iter().map(|(name, _)| name));
            }
        }
        if matches!(n.kind(), "data_type" | "newtype") {
            let Some(t) = c.owner(n).filter(|t| t.kind == "type") else {
                continue;
            };
            for declaration in walk(n) {
                let name = if declaration.kind() == "constructor" {
                    Some(c.text(declaration))
                } else if declaration.kind() == "field" {
                    declaration.child_by_field_name("name").map(|n| c.text(n))
                } else {
                    None
                };
                if let Some(name) = name.filter(|s| !s.is_empty()) {
                    let entries = declarations.entry(name.into()).or_default();
                    if !entries
                        .iter()
                        .any(|e| e.location.start_offset == t.location.start_offset)
                    {
                        entries.push(t.clone());
                    }
                }
            }
        }
    }
    let resolve = |n, name: Option<&str>| {
        let Some(name) = name.filter(|s| !s.is_empty()) else {
            return Resolved::UNKNOWN;
        };
        if let Some(b) = lexical(c, n, name) {
            return b;
        }
        let mut targets = targets(c, name, false);
        targets.extend(declarations.get(name).into_iter().flatten().cloned());
        let mut seen = HashSet::new();
        targets.retain(|t| seen.insert(t.location.start_offset));
        if targets.len() == 1 {
            Resolved::target(targets.remove(0))
        } else if !targets.is_empty() {
            Resolved::UNKNOWN
        } else if imported_roots.contains(name) {
            Resolved::IMPORT
        } else {
            Resolved::UNKNOWN
        }
    };
    let mut facts = Vec::new();
    for n in nodes {
        if n.kind() == "import" {
            facts.extend(imports(c, n));
        }
        if inside_pattern(n) {
            continue;
        }
        if n.kind() == "apply"
            && !n.parent().is_some_and(|p| {
                p.kind() == "apply" && p.child_by_field_name("function") == Some(n)
            })
        {
            let callee = callee(n);
            facts.push(c.call(
                c.text(callee.unwrap_or(n)).into(),
                n,
                resolve(n, callee.and_then(|n| callee_root(c, n))),
                c.owner(n),
            ));
        }
        if n.kind() == "infix"
            && let Some(op) = n.child_by_field_name("operator")
        {
            facts.push(c.call(
                c.text(op).into(),
                n,
                resolve(n, Some(c.text(op))),
                c.owner(n),
            ));
        }
    }
    facts
}
