//! Enforce the internal domain direction using the Rust parser already shipped by Mimirs.
use std::{collections::BTreeSet, fs, path::Path};
use tree_sitter::{Node, Parser};

fn domain(path: &[String]) -> &str {
    match path.first().map(String::as_str).unwrap_or("main") {
        "files" | "git" | "channel" | "profiling" | "collation" => "foundation",
        "storage" if path.get(1).is_some_and(|v| v == "writer") => "foundation",
        "index" | "retrieval" | "storage" | "embedding" => "index",
        "commands" | "mcp" | "input" | "main" => "adapters",
        value => value,
    }
}
fn allowed(from: &str, to: &str) -> bool {
    from == to
        || from == "adapters"
        || to == "foundation"
        || match from {
            "analysis" => to == "source",
            "config" => matches!(to, "analysis" | "source"),
            "index" | "knowledge" => matches!(to, "analysis" | "source" | "config" | "status"),
            "context" => matches!(
                to,
                "index" | "knowledge" | "analysis" | "source" | "config" | "status"
            ),
            "watch" => matches!(
                to,
                "index" | "knowledge" | "analysis" | "source" | "config" | "status"
            ),
            _ => false,
        }
}
fn parts(value: &str) -> Vec<String> {
    value
        .split("::")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}
fn target(module: &[String], path: &[String]) -> Option<Vec<String>> {
    let (first, rest) = path.split_first()?;
    match first.as_str() {
        "crate" => Some(rest.to_vec()),
        "self" => Some(module.iter().chain(rest).cloned().collect()),
        "super" => {
            let mut base = module.to_vec();
            let mut i = 0;
            while path.get(i).is_some_and(|s| s == "super") {
                base.pop();
                i += 1;
            }
            base.extend_from_slice(&path[i..]);
            Some(base)
        }
        _ => None,
    }
}
fn imports(node: Node<'_>, text: &[u8], prefix: &[String], out: &mut Vec<Vec<String>>) {
    match node.kind() {
        "use_declaration" | "use_list" => {
            for child in node.named_children(&mut node.walk()) {
                imports(child, text, prefix, out);
            }
        }
        "scoped_use_list" => {
            let mut prefix = prefix.to_vec();
            if let Some(path) = node.child_by_field_name("path") {
                prefix.extend(parts(path.utf8_text(text).unwrap()));
            }
            imports(
                node.child_by_field_name("list").unwrap(),
                text,
                &prefix,
                out,
            );
        }
        "use_as_clause" => imports(node.child_by_field_name("path").unwrap(), text, prefix, out),
        "use_wildcard" => {
            if let Some(path) = node.named_child(0) {
                imports(path, text, prefix, out);
            } else {
                out.push(prefix.to_vec());
            }
        }
        "identifier" | "scoped_identifier" | "crate" | "self" | "super" => {
            let mut path = prefix.to_vec();
            path.extend(parts(node.utf8_text(text).unwrap()));
            out.push(path);
        }
        _ => {}
    }
}
fn check(module: &[String], source: &str) -> (BTreeSet<(String, String)>, Vec<String>) {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .unwrap();
    let tree = parser.parse(source, None).unwrap();
    assert!(!tree.root_node().has_error(), "invalid Rust in {module:?}");
    let mut edges = BTreeSet::new();
    let mut violations = Vec::new();
    let mut stack = vec![(tree.root_node(), module.to_vec())];
    while let Some((node, module)) = stack.pop() {
        let mut prior = node.prev_named_sibling();
        let mut test = false;
        while let Some(attribute) = prior.filter(|p| p.kind() == "attribute_item") {
            let text = attribute
                .utf8_text(source.as_bytes())
                .unwrap()
                .replace(' ', "");
            test |= text.contains("cfg(test)");
            prior = attribute.prev_named_sibling();
        }
        if test {
            continue;
        }
        let mut paths = Vec::new();
        if node.kind() == "use_declaration" {
            imports(node, source.as_bytes(), &[], &mut paths);
        } else if matches!(node.kind(), "scoped_identifier" | "scoped_type_identifier") {
            paths.push(parts(node.utf8_text(source.as_bytes()).unwrap()));
        }
        for path in paths {
            if let Some(target) = target(&module, &path) {
                if target.is_empty() {
                    violations
                        .push("crate-root aliases/globs are not permitted; name the domain".into());
                    continue;
                }
                let (from, to) = (domain(&module), domain(&target));
                edges.insert((from.into(), to.into()));
                if !allowed(from, to) {
                    violations.push(format!("{from} -> {to}: {}", path.join("::")));
                }
            }
        }
        if node.kind() == "use_declaration" {
            continue;
        }
        let mut child_module = module;
        if node.kind() == "mod_item" && node.child_by_field_name("body").is_some() {
            child_module.push(
                node.child_by_field_name("name")
                    .unwrap()
                    .utf8_text(source.as_bytes())
                    .unwrap()
                    .into(),
            );
        }
        for child in node.named_children(&mut node.walk()) {
            stack.push((child, child_module.clone()));
        }
    }
    (edges, violations)
}
fn files(root: &Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, found);
        } else if path.extension().is_some_and(|s| s == "rs") {
            found.push(path);
        }
    }
}
#[test]
fn production_domains_follow_the_directed_map() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    files(&root, &mut paths);
    paths.sort();
    let mut errors = Vec::new();
    for path in paths {
        let relative = path.strip_prefix(&root).unwrap().with_extension("");
        let module = relative
            .components()
            .map(|p| p.as_os_str().to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let (_, violations) = check(&module, &fs::read_to_string(&path).unwrap());
        errors.extend(
            violations
                .into_iter()
                .map(|v| format!("{}: {v}", relative.display())),
        );
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}
#[test]
fn forbidden_direct_grouped_relative_and_aliased_dependencies_are_rejected() {
    let module = vec!["knowledge".into(), "assessment".into()];
    for source in [
        "fn bad() { crate::commands::run(); }",
        "use crate::{source, commands::{index as wrong}};",
        "use super::super::context::task;",
        "use crate::watch as hidden;",
        "use crate as hidden;",
    ] {
        assert!(!check(&module, source).1.is_empty(), "missed {source}");
    }
    assert!(check(&module, "// crate::commands::run();\n const TEXT: &str = \"crate::commands::run()\"; #[cfg(test)] use crate::commands;").1.is_empty());
    let (edges, errors) = check(
        &module,
        "use crate::{source::{SourceFile as File}, analysis};",
    );
    assert!(errors.is_empty());
    assert!(edges.contains(&("knowledge".into(), "source".into())));
    assert!(edges.contains(&("knowledge".into(), "analysis".into())));
}
