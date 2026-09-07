use super::*;

struct Type {
    file: usize,
    chunk: usize,
    qualified: String,
}
struct Namespace {
    name: String,
    file: usize,
    chunk: Option<usize>,
}
pub(super) struct Index {
    language: &'static str,
    types: HashMap<String, Vec<Type>>,
    namespaces: Vec<Namespace>,
    globals: Vec<(usize, usize)>,
}
fn package(file: &File<'_>) -> Option<String> {
    let names: HashSet<_> = file
        .top
        .iter()
        .filter(|c| c.kind == "package")
        .map(|c| c.name.as_str())
        .collect();
    if names.is_empty() {
        Some(String::new())
    } else if names.len() == 1 {
        names.into_iter().next().map(str::to_owned)
    } else {
        None
    }
}
fn java_callee(callee: &str) -> String {
    let mut output = String::new();
    let mut rest = callee;
    while let Some(start) = rest.find(".<") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('>').filter(|&end| end > 0) else {
            break;
        };
        output.push_str(&rest[..start + 1]);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    output
}
impl Index {
    pub fn new(project: &Project<'_>, language: &'static str) -> Self {
        let mut index = Self {
            language,
            types: HashMap::new(),
            namespaces: Vec::new(),
            globals: Vec::new(),
        };
        let kinds: &[&str] = if language == "java" {
            &["class", "interface", "record", "enum", "annotation_type"]
        } else {
            &["class", "interface", "struct", "record", "enum", "delegate"]
        };
        for (file_id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == language)
        {
            let namespace = if language == "java" {
                let Some(package) = package(file) else {
                    continue;
                };
                package
            } else {
                String::new()
            };
            index.namespaces.push(Namespace {
                name: namespace.clone(),
                file: file_id,
                chunk: None,
            });
            let mut scopes: Vec<Option<(String, Vec<String>)>> =
                vec![None; file.analysis.source_chunks.len()];
            for (id, chunk) in file.analysis.source_chunks.iter().enumerate() {
                let scope = match chunk.parent {
                    None => Some((namespace.clone(), Vec::new())),
                    Some(parent) => scopes[parent].clone(),
                };
                let (Some((namespace, mut enclosing)), Some(name)) = (scope, chunk.name.as_ref())
                else {
                    continue;
                };
                if language == "csharp" && chunk.kind == "module" {
                    let qualified =
                        if !namespace.is_empty() && !name.starts_with(&format!("{namespace}.")) {
                            format!("{namespace}.{name}")
                        } else {
                            name.clone()
                        };
                    index.namespaces.push(Namespace {
                        name: qualified.clone(),
                        file: file_id,
                        chunk: Some(id),
                    });
                    scopes[id] = Some((qualified, Vec::new()));
                } else if kinds.contains(&chunk.kind.as_str()) {
                    enclosing.push(name.clone());
                    let qualified = if namespace.is_empty() {
                        enclosing.join(".")
                    } else {
                        format!("{namespace}.{}", enclosing.join("."))
                    };
                    index
                        .types
                        .entry(qualified.clone())
                        .or_default()
                        .push(Type {
                            file: file_id,
                            chunk: id,
                            qualified,
                        });
                    scopes[id] = Some((namespace, enclosing));
                }
            }
            if language == "csharp" {
                index.globals.extend(
                    file.imports
                        .iter()
                        .enumerate()
                        .filter(|(_, f)| f.global)
                        .map(|(id, _)| (file_id, id)),
                );
            }
        }
        index
    }
    pub fn has_root(&self, root: &str) -> bool {
        self.namespaces
            .iter()
            .any(|n| n.name == root || n.name.starts_with(&format!("{root}.")))
    }
    fn select(&self, name: &str) -> Option<&Type> {
        let name = if self.language == "csharp" {
            name.strip_prefix("global::").unwrap_or(name)
        } else {
            name
        };
        let candidates = self.types.get(name)?;
        if candidates.len() == 1 {
            candidates.first()
        } else {
            None
        }
    }
    fn target(&self, project: &Project<'_>, t: &Type) -> Option<Target> {
        Some(Target {
            file: t.file,
            chunk: chunk_ref(&project.files[t.file].analysis.source_chunks[t.chunk])?,
        })
    }
    fn method(&self, project: &Project<'_>, t: &Type, name: &str) -> Option<Target> {
        unique(
            project.files[t.file]
                .analysis
                .source_chunks
                .iter()
                .filter(|c| {
                    c.parent == Some(t.chunk)
                        && c.name.as_deref() == Some(name)
                        && (c.kind == "method"
                            || (self.language == "csharp" && c.kind == "function"))
                })
                .filter_map(chunk_ref)
                .map(|chunk| Target {
                    file: t.file,
                    chunk,
                }),
        )
    }
    pub fn resolve_import(&self, project: &Project<'_>, fact: Import<'_>) -> Option<ImportTarget> {
        if self.language == "java" {
            if fact.imported == Some("module") {
                return None;
            }
            if fact.is_static || fact.local.is_some() {
                return self
                    .select(fact.source)
                    .map(|t| ImportTarget::file(project, t.file));
            }
        } else if let Some(t) = self.select(fact.source) {
            return Some(ImportTarget::file(project, t.file));
        }
        let source = if self.language == "csharp" {
            fact.source.strip_prefix("global::").unwrap_or(fact.source)
        } else {
            fact.source
        };
        self.namespaces
            .iter()
            .any(|n| n.name == source)
            .then(|| ImportTarget {
                path: source.into(),
                package: true,
            })
    }
    fn namespace_at(&self, project: &Project<'_>, file: usize, offset: usize) -> &str {
        self.namespaces
            .iter()
            .filter(|n| project.files[n.file].path == project.files[file].path)
            .filter_map(|n| {
                let chunk = &project.files[n.file].analysis.source_chunks[n.chunk?];
                (chunk.span.start <= offset && chunk.span.end >= offset)
                    .then_some((n, chunk.span.end - chunk.span.start))
            })
            .min_by_key(|(_, size)| *size)
            .map(|(n, _)| n.name.as_str())
            .unwrap_or("")
    }
    fn csharp_member(
        &self,
        project: &Project<'_>,
        type_name: &str,
        remaining: &[&str],
    ) -> Option<Target> {
        let exact = std::iter::once(type_name)
            .chain(remaining.iter().copied())
            .collect::<Vec<_>>()
            .join(".");
        if let Some(t) = self.select(&exact) {
            return self.target(project, t);
        }
        let t = self.select(type_name)?;
        if remaining.is_empty() {
            self.target(project, t)
        } else if remaining.len() == 1 {
            self.method(project, t, remaining[0])
        } else {
            None
        }
    }
    fn csharp_call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Unknown | Binding::Import) {
            return None;
        }
        let callee = without_type_args(fact.callee);
        let callee = callee
            .strip_prefix("global::")
            .unwrap_or(&callee)
            .replace("::", ".");
        let parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let imports = project.files[file].imports.iter().copied().chain(
            self.globals
                .iter()
                .filter(|(id, _)| *id != file)
                .map(|&(id, import)| project.files[id].imports[import]),
        );
        let mut candidates = Vec::new();
        for imported in imports {
            let source = imported
                .source
                .strip_prefix("global::")
                .unwrap_or(imported.source);
            if imported.is_static && parts.len() == 1 {
                candidates.extend(
                    self.select(source)
                        .and_then(|t| self.method(project, t, root)),
                );
            } else if imported.local == Some(root) {
                candidates.extend(self.csharp_member(project, source, &parts[1..]));
            } else if !imported.is_static && imported.local.is_none() {
                candidates.extend(self.csharp_member(
                    project,
                    &format!("{source}.{root}"),
                    &parts[1..],
                ));
            }
        }
        let namespace = self.namespace_at(project, file, fact.fact.location.start_offset);
        let local = if namespace.is_empty() {
            root.to_owned()
        } else {
            format!("{namespace}.{root}")
        };
        candidates.extend(self.csharp_member(project, &local, &parts[1..]));
        candidates.extend(self.csharp_member(project, root, &parts[1..]));
        unique(candidates)
    }
    fn java_imported(&self, project: &Project<'_>, file: usize, callee: &str) -> Option<Target> {
        let callee = java_callee(callee);
        let parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let mut candidates = Vec::new();
        for fact in &project.files[file].imports {
            if fact.is_static {
                if fact.imported == Some("*") || fact.local != Some(callee.as_str()) {
                    continue;
                }
                if let (Some(t), Some(name)) = (self.select(fact.source), fact.imported) {
                    candidates.extend(self.method(project, t, name));
                }
                continue;
            }
            if fact.local != Some(root) {
                continue;
            }
            let Some(t) = self.select(fact.source) else {
                continue;
            };
            let nested = std::iter::once(t.qualified.as_str())
                .chain(parts.iter().skip(1).copied())
                .collect::<Vec<_>>()
                .join(".");
            if let Some(nested) = self.select(&nested) {
                candidates.extend(self.target(project, nested));
            } else if parts.len() == 1 {
                candidates.extend(self.target(project, t));
            } else if parts.len() == 2 {
                candidates.extend(self.method(project, t, parts[1]));
            }
        }
        unique(candidates)
    }
    pub fn call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        if self.language == "csharp" {
            return self.csharp_call(project, file, fact);
        }
        if fact.binding == Binding::Import {
            return self.java_imported(project, file, fact.callee);
        }
        if fact.binding != Binding::Unknown {
            return None;
        }
        let callee = java_callee(fact.callee);
        let parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            return None;
        }
        let mut candidates = Vec::new();
        if let Some(package) = package(&project.files[file]) {
            let prefix = if package.is_empty() {
                String::new()
            } else {
                format!("{package}.")
            };
            candidates.extend(
                self.select(&format!("{prefix}{}", parts.join(".")))
                    .and_then(|t| self.target(project, t)),
            );
            if parts.len() >= 2 {
                candidates.extend(
                    self.select(&format!("{prefix}{}", parts[..parts.len() - 1].join(".")))
                        .and_then(|t| self.method(project, t, parts[parts.len() - 1])),
                );
            }
        }
        candidates.extend(self.select(&callee).and_then(|t| self.target(project, t)));
        if parts.len() >= 2 {
            candidates.extend(
                self.select(&parts[..parts.len() - 1].join("."))
                    .and_then(|t| self.method(project, t, parts[parts.len() - 1])),
            );
        }
        unique(candidates)
    }
}
