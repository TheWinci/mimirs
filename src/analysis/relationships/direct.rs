use super::*;

pub(super) fn lua_paths(source: &str) -> Vec<String> {
    let path = if source.contains('/') {
        source.into()
    } else {
        source.replace('.', "/")
    };
    [format!("{path}.lua"), format!("{path}/init.lua")]
        .iter()
        .map(|p| normalized(p))
        .collect()
}
pub(super) fn import(project: &Project<'_>, file: &File<'_>, fact: Import<'_>) -> Option<usize> {
    match file.language {
        "bash" => {
            if fact.source.starts_with('/') || !fact.source.contains('/') {
                return None;
            }
            project
                .file(&normalized(fact.source))
                .filter(|&id| project.files[id].language == "bash")
        }
        "zig" => {
            if fact.imported == Some("c-header") || !fact.source.ends_with(".zig") {
                return None;
            }
            project
                .file(&join(dirname(&file.path), fact.source))
                .filter(|&id| project.files[id].language == "zig")
        }
        "lua" => {
            if fact.imported != Some("*") {
                return None;
            }
            let targets = unique_files(
                project,
                lua_paths(fact.source)
                    .iter()
                    .filter_map(|p| project.file(p))
                    .filter(|&id| project.files[id].language == "lua"),
            );
            if targets.len() == 1 {
                targets.first().copied()
            } else {
                None
            }
        }
        _ => local_header(project, file, fact.source),
    }
}
fn identifier(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}
fn qualified_cpp(project: &Project<'_>, file: usize, name: &str) -> Vec<Target> {
    let chunks = &project.files[file].analysis.source_chunks;
    chunks
        .iter()
        .filter(|c| {
            matches!(
                c.kind.as_str(),
                "function" | "method" | "macro" | "class" | "struct"
            )
        })
        .filter_map(|chunk| {
            let reference = chunk_ref(chunk)?;
            let qualified = if reference.name.contains("::") {
                reference.name.clone()
            } else {
                let mut prefix = Vec::new();
                let mut parent = chunk.parent;
                while let Some(id) = parent {
                    let p = &chunks[id];
                    if matches!(p.kind.as_str(), "module" | "class" | "struct")
                        && let Some(name) = &p.name
                    {
                        prefix.push(name.as_str());
                    }
                    parent = p.parent;
                }
                prefix.reverse();
                prefix.push(&reference.name);
                prefix.join("::")
            };
            (qualified == name).then_some(Target {
                file,
                chunk: reference,
            })
        })
        .collect()
}
pub(super) fn call(project: &Project<'_>, file_id: usize, fact: Call<'_>) -> Option<Target> {
    let file = &project.files[file_id];
    let mut candidates = Vec::new();
    match file.language {
        "bash" if fact.binding == Binding::Unknown && identifier(fact.callee) => {
            for &imported in &file.imports {
                if imported.fact.owner.is_some()
                    || imported.fact.location.start_offset > fact.fact.location.start_offset
                {
                    continue;
                }
                if let Some(target) = import(project, file, imported) {
                    candidates.extend(named_targets(project, target, fact.callee, &["function"]));
                }
            }
        }
        "zig" if fact.binding == Binding::Import => {
            let parts: Vec<_> = fact.callee.split('.').filter(|s| !s.is_empty()).collect();
            if parts.len() != 2 {
                return None;
            }
            for &imported in &file.imports {
                if imported.local == Some(parts[0])
                    && imported.imported != Some("c-header")
                    && let Some(target) = import(project, file, imported)
                {
                    candidates.extend(named_targets(project, target, parts[1], &["function"]));
                }
            }
        }
        "c" if fact.binding == Binding::Unknown && identifier(fact.callee) => {
            for imported in &file.imports {
                if let Some(target) = local_header(project, file, imported.source) {
                    candidates.extend(named_targets(
                        project,
                        target,
                        fact.callee,
                        &["function", "macro"],
                    ));
                }
            }
        }
        "cpp" if matches!(fact.binding, Binding::Unknown | Binding::Import) => {
            let callee = without_type_args(fact.callee);
            let mut names = HashSet::from([callee.clone()]);
            for imported in &file.imports {
                let Some(name) = imported.imported else {
                    continue;
                };
                if name != "*" && imported.local == Some(callee.as_str()) {
                    names.insert(format!("{}::{name}", imported.source));
                } else if name == "*"
                    && let Some(local) = imported.local
                    && callee.starts_with(&format!("{local}::"))
                {
                    names.insert(format!("{}{}", imported.source, &callee[local.len()..]));
                }
            }
            for imported in file.imports.iter().filter(|f| f.imported.is_none()) {
                if let Some(header) = local_header(project, file, imported.source) {
                    for name in &names {
                        candidates.extend(qualified_cpp(project, header, name));
                    }
                }
            }
        }
        _ => {}
    }
    unique(candidates)
}
