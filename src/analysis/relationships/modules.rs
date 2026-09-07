use super::*;

struct Module {
    file: usize,
    chunk: Option<usize>,
}
pub(super) struct Index {
    language: &'static str,
    modules: HashMap<String, Vec<Module>>,
}
fn ocaml_unit(path: &str) -> Option<String> {
    let ext = extension(path);
    if !matches!(ext, "ml" | "mli") {
        return None;
    }
    let basename = path.rsplit('/').next()?.strip_suffix(&format!(".{ext}"))?;
    let mut chars = basename.chars();
    let first = chars.next()?;
    Some(format!("{}{}", first.to_uppercase(), chars.as_str()))
}
impl Index {
    pub fn new(project: &Project<'_>, language: &'static str) -> Self {
        let mut modules: HashMap<String, Vec<Module>> = HashMap::new();
        for (file_id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == language)
        {
            if language == "elixir" {
                for (id, chunk) in file
                    .analysis
                    .source_chunks
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.kind == "module")
                {
                    if let Some(name) = &chunk.name {
                        modules.entry(name.clone()).or_default().push(Module {
                            file: file_id,
                            chunk: Some(id),
                        });
                    }
                }
                continue;
            }
            if file.path.ends_with(".mli")
                && project
                    .paths
                    .contains_key(&file.path[..file.path.len() - 1])
            {
                continue;
            }
            let Some(unit) = ocaml_unit(&file.path) else {
                continue;
            };
            modules.entry(unit.clone()).or_default().push(Module {
                file: file_id,
                chunk: None,
            });
            let mut prefixes = vec![None; file.analysis.source_chunks.len()];
            for (id, chunk) in file.analysis.source_chunks.iter().enumerate() {
                if chunk.kind != "module" {
                    continue;
                }
                let Some(name) = &chunk.name else { continue };
                let prefix = match chunk.parent {
                    None => Some(&unit),
                    Some(parent) => prefixes[parent].as_ref(),
                };
                let Some(prefix) = prefix else { continue };
                let qualified = format!("{prefix}.{name}");
                modules.entry(qualified.clone()).or_default().push(Module {
                    file: file_id,
                    chunk: Some(id),
                });
                prefixes[id] = Some(qualified);
            }
        }
        Self { language, modules }
    }
    pub fn has_root(&self, root: &str) -> bool {
        self.modules
            .keys()
            .any(|name| name == root || name.starts_with(&format!("{root}.")))
    }
    fn contexts(&self, project: &Project<'_>, file: usize, name: &str) -> Vec<&Module> {
        let mut contexts: Vec<_> = self.modules.get(name).into_iter().flatten().collect();
        if self.language == "ocaml"
            && let Some(unit) = ocaml_unit(&project.files[file].path)
        {
            contexts.extend(
                self.modules
                    .get(&format!("{unit}.{name}"))
                    .into_iter()
                    .flatten(),
            );
        }
        contexts
    }
    pub fn resolve_import(
        &self,
        project: &Project<'_>,
        file: usize,
        source: &str,
    ) -> Option<usize> {
        let files = unique_files(
            project,
            self.contexts(project, file, source)
                .into_iter()
                .map(|m| m.file),
        );
        if files.len() == 1 {
            files.first().copied()
        } else {
            None
        }
    }
    fn member(
        &self,
        project: &Project<'_>,
        file: usize,
        module: &str,
        member: &str,
    ) -> Option<Target> {
        let kinds: &[&str] = if self.language == "elixir" {
            &["function", "method"]
        } else {
            &["function", "class"]
        };
        unique(
            self.contexts(project, file, module)
                .into_iter()
                .flat_map(|module| {
                    project.files[module.file]
                        .analysis
                        .source_chunks
                        .iter()
                        .filter(move |c| {
                            c.parent == module.chunk
                                && kinds.contains(&c.kind.as_str())
                                && c.name.as_deref() == Some(member)
                        })
                        .filter_map(chunk_ref)
                        .map(move |chunk| Target {
                            file: module.file,
                            chunk,
                        })
                }),
        )
    }
    pub fn call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Unknown | Binding::Import)
            || (self.language == "ocaml" && fact.callee.contains('#'))
        {
            return None;
        }
        let parts: Vec<_> = fact.callee.split('.').filter(|s| !s.is_empty()).collect();
        let root = *parts.first()?;
        let mut candidates = Vec::new();
        for imported in &project.files[file].imports {
            if imported.local != Some(root) {
                continue;
            }
            let Some(kind) = imported.imported else {
                continue;
            };
            if parts.len() == 2
                && (if self.language == "elixir" {
                    matches!(kind, "alias" | "require")
                } else {
                    kind == "module"
                })
            {
                candidates.extend(self.member(project, file, imported.source, parts[1]));
            } else if self.language == "elixir"
                && parts.len() == 1
                && let Some((name, _)) = kind.split_once('/').filter(|(name, _)| !name.is_empty())
            {
                candidates.extend(self.member(project, file, imported.source, name));
            }
        }
        if parts.len() >= 2 {
            candidates.extend(self.member(
                project,
                file,
                &parts[..parts.len() - 1].join("."),
                parts[parts.len() - 1],
            ));
        }
        unique(candidates)
    }
}
