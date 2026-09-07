use super::*;

struct Symbol {
    file: usize,
    chunk: usize,
}
pub(super) struct Index {
    language: &'static str,
    packages: HashSet<String>,
    ranges: Vec<(usize, usize, String)>,
    types: HashMap<String, Vec<Symbol>>,
    functions: HashMap<String, Vec<Symbol>>,
}
fn kotlin_package(file: &File<'_>) -> Option<String> {
    let names: HashSet<_> = file
        .top
        .iter()
        .filter(|c| c.kind == "package")
        .map(|c| c.name.clone())
        .collect();
    if names.is_empty() {
        Some(String::new())
    } else if names.len() == 1 {
        names.into_iter().next()
    } else {
        None
    }
}
fn qualified(parts: impl IntoIterator<Item = impl AsRef<str>>) -> String {
    parts
        .into_iter()
        .filter(|s| !s.as_ref().is_empty())
        .map(|s| s.as_ref().to_owned())
        .collect::<Vec<_>>()
        .join(".")
}
impl Index {
    pub fn new(project: &Project<'_>, language: &'static str) -> Self {
        let mut index = Self {
            language,
            packages: HashSet::new(),
            ranges: Vec::new(),
            types: HashMap::new(),
            functions: HashMap::new(),
        };
        let type_kinds: &[&str] = if language == "kotlin" {
            &[
                "class",
                "interface",
                "record",
                "enum",
                "annotation_type",
                "type",
            ]
        } else {
            &["class", "trait", "enum", "type", "module", "given"]
        };
        for (file_id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == language)
        {
            let package = if language == "kotlin" {
                let Some(name) = kotlin_package(file) else {
                    continue;
                };
                name
            } else {
                String::new()
            };
            index.packages.insert(package.clone());
            let mut scopes: Vec<Option<(String, Vec<String>, bool)>> =
                vec![None; file.analysis.source_chunks.len()];
            for (id, chunk) in file.analysis.source_chunks.iter().enumerate() {
                let scope = match chunk.parent {
                    None => Some((package.clone(), Vec::new(), true)),
                    Some(parent) => scopes[parent].clone(),
                };
                let Some((package, mut enclosing, package_only)) = scope else {
                    continue;
                };
                if chunk.kind == "package" {
                    if language == "kotlin" {
                        scopes[id] = Some((package, enclosing, package_only));
                    } else if let Some(name) = &chunk.name {
                        let name =
                            if !package.is_empty() && !name.starts_with(&format!("{package}.")) {
                                format!("{package}.{name}")
                            } else {
                                name.clone()
                            };
                        index.packages.insert(name.clone());
                        if package_only {
                            index.ranges.push((file_id, id, name.clone()));
                        }
                        scopes[id] = Some((name, Vec::new(), package_only));
                    }
                    continue;
                }
                let Some(name) = &chunk.name else { continue };
                if type_kinds.contains(&chunk.kind.as_str()) {
                    enclosing.push(name.clone());
                    let qualified = qualified(std::iter::once(&package).chain(enclosing.iter()));
                    index.types.entry(qualified).or_default().push(Symbol {
                        file: file_id,
                        chunk: id,
                    });
                    scopes[id] = Some((package, enclosing, false));
                } else if enclosing.is_empty()
                    && (chunk.kind == "function" || (language == "scala" && chunk.kind == "method"))
                {
                    index
                        .functions
                        .entry(qualified([&package, name]))
                        .or_default()
                        .push(Symbol {
                            file: file_id,
                            chunk: id,
                        });
                }
            }
        }
        index
    }
    pub fn has_root(&self, root: &str) -> bool {
        self.packages
            .iter()
            .any(|p| p == root || p.starts_with(&format!("{root}.")))
    }
    fn symbols<'a>(&'a self, name: &str, functions: bool) -> &'a [Symbol] {
        (if functions {
            &self.functions
        } else {
            &self.types
        })
        .get(name)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    }
    fn unique_file<'a>(
        &self,
        project: &Project<'_>,
        symbols: impl IntoIterator<Item = &'a Symbol>,
    ) -> Option<usize> {
        let files = unique_files(project, symbols.into_iter().map(|s| s.file));
        if files.len() == 1 {
            files.first().copied()
        } else {
            None
        }
    }
    fn target(&self, project: &Project<'_>, symbol: &Symbol) -> Option<Target> {
        Some(Target {
            file: symbol.file,
            chunk: chunk_ref(&project.files[symbol.file].analysis.source_chunks[symbol.chunk])?,
        })
    }
    fn member(&self, project: &Project<'_>, name: &str, member: &str) -> Option<Target> {
        unique(self.symbols(name, false).iter().flat_map(|symbol| {
            project.files[symbol.file]
                .analysis
                .source_chunks
                .iter()
                .filter(move |chunk| {
                    chunk.parent == Some(symbol.chunk)
                        && chunk.name.as_deref() == Some(member)
                        && (chunk.kind == "method"
                            || (self.language == "scala" && chunk.kind == "function"))
                })
                .filter_map(chunk_ref)
                .map(move |chunk| Target {
                    file: symbol.file,
                    chunk,
                })
        }))
    }
    pub fn resolve_import(&self, project: &Project<'_>, fact: Import<'_>) -> Option<ImportTarget> {
        if fact.imported == Some("*")
            || (self.language == "scala"
                && fact
                    .imported
                    .is_some_and(|s| s == "given" || s.starts_with("given ")))
        {
            if let Some(file) = self.unique_file(project, self.symbols(fact.source, false).iter()) {
                return Some(ImportTarget::file(project, file));
            }
            return self.packages.contains(fact.source).then(|| ImportTarget {
                path: fact.source.into(),
                package: true,
            });
        }
        let name = qualified([fact.source, fact.imported.unwrap_or("")]);
        if let Some(file) = self.unique_file(
            project,
            self.symbols(&name, false)
                .iter()
                .chain(self.symbols(&name, true)),
        ) {
            return Some(ImportTarget::file(project, file));
        }
        let owners = self.symbols(fact.source, false);
        let owner = self.unique_file(project, owners.iter())?;
        owners
            .iter()
            .any(|symbol| {
                project.files[symbol.file]
                    .analysis
                    .source_chunks
                    .iter()
                    .any(|c| {
                        c.parent == Some(symbol.chunk)
                            && c.name.as_deref() == fact.imported
                            && (self.language == "scala" || c.kind == "method")
                    })
            })
            .then(|| ImportTarget::file(project, owner))
    }
    fn qualified_targets(
        &self,
        project: &Project<'_>,
        name: &str,
        remaining: &[&str],
    ) -> Option<Target> {
        if remaining.len() == 1 {
            return self.member(project, name, remaining[0]);
        }
        if !remaining.is_empty() {
            return None;
        }
        let function = unique(
            self.symbols(name, true)
                .iter()
                .filter_map(|s| self.target(project, s)),
        );
        let kinds: &[&str] = if self.language == "kotlin" {
            &["class", "record", "enum", "annotation_type", "type"]
        } else {
            &["class", "enum", "type"]
        };
        function.or_else(|| {
            unique(
                self.symbols(name, false)
                    .iter()
                    .filter(|s| {
                        kinds.contains(
                            &project.files[s.file].analysis.source_chunks[s.chunk]
                                .kind
                                .as_str(),
                        )
                    })
                    .filter_map(|s| self.target(project, s)),
            )
        })
    }
    pub fn call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Unknown | Binding::Import) {
            return None;
        }
        let callee = if self.language == "kotlin" {
            without_type_args(fact.callee)
        } else {
            without_pairs(fact.callee, '[', ']')
        };
        if callee.contains(char::is_whitespace)
            || (self.language == "kotlin" && callee.contains("?."))
        {
            return None;
        }
        let parts: Vec<_> = callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let mut candidates = Vec::new();
        for imported in &project.files[file].imports {
            if imported.local != Some(root)
                || (self.language == "kotlin" && imported.imported == Some("*"))
            {
                continue;
            }
            if self.language == "scala" && imported.imported.is_none() {
                continue;
            }
            let name = qualified([imported.source, imported.imported.unwrap_or("")]);
            candidates.extend(self.qualified_targets(project, &name, &parts[1..]));
            if parts.len() == 1
                && let Some(name) = imported.imported
            {
                candidates.extend(self.member(project, imported.source, name));
            }
        }
        let package = if self.language == "kotlin" {
            kotlin_package(&project.files[file])
        } else {
            Some(
                self.ranges
                    .iter()
                    .filter_map(|(file_id, id, name)| {
                        if *file_id != file {
                            return None;
                        }
                        let span = &project.files[file].analysis.source_chunks[*id].span;
                        (span.start <= fact.fact.location.start_offset
                            && span.end >= fact.fact.location.start_offset)
                            .then_some((name, span.end - span.start))
                    })
                    .min_by_key(|(_, size)| *size)
                    .map(|(name, _)| name.clone())
                    .unwrap_or_default(),
            )
        };
        if let Some(package) = package {
            candidates.extend(self.qualified_targets(
                project,
                &qualified([package.as_str(), root]),
                &parts[1..],
            ));
        }
        candidates.extend(self.qualified_targets(project, root, &parts[1..]));
        unique(candidates)
    }
}
