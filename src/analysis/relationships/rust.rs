use super::*;

struct Module {
    root: String,
    path: Vec<String>,
    file: usize,
    declaration: Option<usize>,
    chunks: Vec<usize>,
}
pub(super) struct Index {
    modules: Vec<Module>,
    keys: HashMap<(String, Vec<String>), Vec<usize>>,
    file_modules: HashMap<usize, usize>,
}
struct Resolved {
    module: usize,
    declaration: Option<ChunkRef>,
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut roots: Vec<_> = project
            .files
            .iter()
            .filter(|f| {
                f.language == "rust"
                    && matches!(f.path.rsplit('/').next(), Some("lib.rs" | "main.rs"))
            })
            .map(|f| dirname(&f.path).to_owned())
            .collect();
        roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
        roots.dedup();
        let mut index = Self {
            modules: Vec::new(),
            keys: HashMap::new(),
            file_modules: HashMap::new(),
        };
        for (file_id, file) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == "rust")
        {
            let Some(root) = roots
                .iter()
                .find(|r| *r == "." || file.path == **r || file.path.starts_with(&format!("{r}/")))
            else {
                continue;
            };
            let relative = if root == "." {
                file.path.as_str()
            } else {
                file.path
                    .strip_prefix(&format!("{root}/"))
                    .unwrap_or(&file.path)
            };
            let mut path: Vec<String> = relative
                .strip_suffix(".rs")
                .unwrap_or(relative)
                .split('/')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            if path
                .last()
                .is_some_and(|s| matches!(s.as_str(), "lib" | "main" | "mod"))
            {
                path.pop();
            }
            let module = Module {
                root: root.clone(),
                path,
                file: file_id,
                declaration: None,
                chunks: file
                    .analysis
                    .source_chunks
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.parent.is_none())
                    .map(|(i, _)| i)
                    .collect(),
            };
            let id = index.add(module);
            index.file_modules.insert(file_id, id);
            index.inline(project, id);
        }
        index
    }
    fn add(&mut self, module: Module) -> usize {
        let id = self.modules.len();
        self.keys
            .entry((module.root.clone(), module.path.clone()))
            .or_default()
            .push(id);
        self.modules.push(module);
        id
    }
    fn inline(&mut self, project: &Project<'_>, parent: usize) {
        for chunk_id in self.modules[parent].chunks.clone() {
            let file = self.modules[parent].file;
            let chunk = &project.files[file].analysis.source_chunks[chunk_id];
            let Some(name) = chunk.name.as_ref().filter(|_| chunk.kind == "module") else {
                continue;
            };
            let children: Vec<_> = project.files[file]
                .analysis
                .source_chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.parent == Some(chunk_id))
                .map(|(id, _)| id)
                .collect();
            if children.is_empty()
                && project.files[file].analysis.source.text[chunk.span.start..chunk.span.end]
                    .trim_end()
                    .ends_with(';')
            {
                continue;
            }
            let mut path = self.modules[parent].path.clone();
            path.push(name.clone());
            let id = self.add(Module {
                root: self.modules[parent].root.clone(),
                path,
                file,
                declaration: Some(chunk_id),
                chunks: children,
            });
            self.inline(project, id);
        }
    }
    fn containing(&self, project: &Project<'_>, file: usize, offset: usize) -> Option<&Module> {
        let root = &self.modules[*self.file_modules.get(&file)?];
        Some(
            self.modules
                .iter()
                .filter(|m| m.file == file)
                .filter_map(|m| {
                    m.declaration
                        .map(|id| (m, &project.files[file].analysis.source_chunks[id]))
                })
                .filter(|(_, c)| c.span.start <= offset && c.span.end >= offset)
                .min_by_key(|(_, c)| c.span.end - c.span.start)
                .map(|(m, _)| m)
                .unwrap_or(root),
        )
    }
    fn select(&self, root: &str, path: &[String]) -> Option<usize> {
        let ids = self.keys.get(&(root.into(), path.to_vec()))?;
        (ids.len() == 1).then(|| ids[0])
    }
    fn declaration(&self, project: &Project<'_>, module: usize, name: &str) -> Option<ChunkRef> {
        let module = &self.modules[module];
        unique(
            module
                .chunks
                .iter()
                .map(|&id| &project.files[module.file].analysis.source_chunks[id])
                .filter(|c| {
                    c.name.as_deref() == Some(name)
                        && matches!(
                            c.kind.as_str(),
                            "function"
                                | "macro"
                                | "struct"
                                | "enum"
                                | "trait"
                                | "type"
                                | "constant"
                                | "variable"
                        )
                })
                .filter_map(chunk_ref)
                .map(|chunk| Target {
                    file: module.file,
                    chunk,
                }),
        )
        .map(|t| t.chunk)
    }
    fn resolve(
        &self,
        project: &Project<'_>,
        file: usize,
        source: &str,
        offset: usize,
        module_declaration: bool,
        expression: bool,
    ) -> Option<Resolved> {
        let current = self.containing(project, file, offset)?;
        let parts: Vec<String> = source
            .strip_suffix('!')
            .unwrap_or(source)
            .split("::")
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let (bases, rest) = if module_declaration {
            (vec![current.path.clone()], parts.as_slice())
        } else {
            match parts.first().map(String::as_str) {
                Some("crate") => (vec![vec![]], &parts[1..]),
                Some("self") => (vec![current.path.clone()], &parts[1..]),
                Some("super") => {
                    let count = parts.iter().take_while(|s| *s == "super").count();
                    if count > current.path.len() {
                        return None;
                    }
                    (
                        vec![current.path[..current.path.len() - count].to_vec()],
                        &parts[count..],
                    )
                }
                _ => (
                    if expression && !current.path.is_empty() {
                        vec![current.path.clone(), vec![]]
                    } else {
                        vec![vec![]]
                    },
                    parts.as_slice(),
                ),
            }
        };
        let mut candidates = HashMap::new();
        for base in bases {
            if module_declaration {
                let mut path = base;
                path.extend_from_slice(rest);
                if let Some(module) = self.select(&current.root, &path) {
                    let m = &self.modules[module];
                    candidates.insert(
                        (m.file, m.path.clone(), None),
                        Resolved {
                            module,
                            declaration: None,
                        },
                    );
                }
                continue;
            }
            for length in (0..=rest.len()).rev() {
                let mut path = base.clone();
                path.extend_from_slice(&rest[..length]);
                let Some(module) = self.select(&current.root, &path) else {
                    continue;
                };
                let remaining = &rest[length..];
                let declaration = if remaining.len() == 1 {
                    self.declaration(project, module, &remaining[0])
                } else {
                    None
                };
                if remaining.is_empty() || declaration.is_some() {
                    let m = &self.modules[module];
                    candidates.insert(
                        (
                            m.file,
                            m.path.clone(),
                            declaration.as_ref().map(|d| d.location.start_offset),
                        ),
                        Resolved {
                            module,
                            declaration,
                        },
                    );
                }
                break;
            }
        }
        if candidates.len() == 1 {
            candidates.into_values().next()
        } else {
            None
        }
    }
    fn resolve_fact(
        &self,
        project: &Project<'_>,
        file: usize,
        fact: Import<'_>,
    ) -> Option<Resolved> {
        self.resolve(
            project,
            file,
            fact.source,
            fact.fact.location.start_offset,
            fact.imported == Some("module"),
            false,
        )
    }
    pub fn import(&self, project: &Project<'_>, file: usize, fact: Import<'_>) -> Option<usize> {
        self.resolve_fact(project, file, fact)
            .map(|r| self.modules[r.module].file)
    }
    pub fn local(&self, project: &Project<'_>, file: usize, fact: Import<'_>) -> bool {
        if fact.imported == Some("module")
            || fact.source == "crate"
            || ["crate::", "self::", "super::"]
                .iter()
                .any(|p| fact.source.starts_with(p))
        {
            return true;
        }
        self.containing(project, file, fact.fact.location.start_offset)
            .is_some_and(|m| {
                self.select(
                    &m.root,
                    &[fact.source.split("::").next().unwrap_or("").into()],
                )
                .is_some()
            })
    }
    pub fn call(&self, project: &Project<'_>, file: usize, fact: Call<'_>) -> Option<Target> {
        let callable =
            |c: &ChunkRef| matches!(c.kind.as_str(), "function" | "macro" | "struct" | "enum");
        if fact.binding == Binding::Import {
            let parts: Vec<_> = fact
                .callee
                .strip_suffix('!')
                .unwrap_or(fact.callee)
                .split("::")
                .filter(|s| !s.is_empty())
                .collect();
            if let Some(root) = parts.first() {
                let target = unique(
                    project.files[file]
                        .imports
                        .iter()
                        .filter(|i| i.local == Some(*root))
                        .filter_map(|&i| {
                            let resolved = self.resolve_fact(project, file, i)?;
                            let chunk = if parts.len() == 1 {
                                resolved.declaration
                            } else if parts.len() == 2 && resolved.declaration.is_none() {
                                self.declaration(project, resolved.module, parts[1])
                            } else {
                                None
                            }?;
                            callable(&chunk).then(|| Target {
                                file: self.modules[resolved.module].file,
                                chunk,
                            })
                        }),
                );
                if target.is_some() {
                    return target;
                }
            }
        }
        if !fact.callee.contains("::") {
            return None;
        }
        let resolved = self.resolve(
            project,
            file,
            fact.callee,
            fact.fact.location.start_offset,
            false,
            true,
        )?;
        resolved.declaration.filter(callable).map(|chunk| Target {
            file: self.modules[resolved.module].file,
            chunk,
        })
    }
}
