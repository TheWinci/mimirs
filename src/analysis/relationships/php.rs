use super::*;

struct Symbol {
    file: usize,
    chunk: usize,
}
pub(super) struct Index {
    namespaces: HashSet<String>,
    types: HashMap<String, Vec<Symbol>>,
    functions: HashMap<String, Vec<Symbol>>,
    constants: HashMap<String, Vec<Symbol>>,
}
pub(super) fn runtime(fact: Import<'_>) -> bool {
    matches!(
        fact.imported,
        Some("require" | "require_once" | "include" | "include_once")
    )
}
impl Index {
    pub fn new(project: &Project<'_>) -> Self {
        let mut index = Self {
            namespaces: HashSet::new(),
            types: HashMap::new(),
            functions: HashMap::new(),
            constants: HashMap::new(),
        };
        for (id, _) in project
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.language == "php")
        {
            index.namespaces.insert(String::new());
            index.visit(project, id, None, "");
        }
        index
    }
    fn visit(
        &mut self,
        project: &Project<'_>,
        file: usize,
        parent: Option<usize>,
        namespace: &str,
    ) {
        for (id, chunk) in project.files[file]
            .analysis
            .source_chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.parent == parent)
        {
            let Some(name) = chunk.name.as_deref() else {
                continue;
            };
            if chunk.kind == "module" {
                let name = if name == "(global)" {
                    ""
                } else {
                    name.trim_start_matches('\\')
                };
                self.namespaces.insert(name.into());
                self.visit(project, file, Some(id), name);
                continue;
            }
            let name = if namespace.is_empty() {
                name.into()
            } else {
                format!("{namespace}\\{name}")
            };
            let map = match chunk.kind.as_str() {
                "class" | "interface" | "trait" | "enum" => &mut self.types,
                "function" => &mut self.functions,
                "constant" => &mut self.constants,
                _ => continue,
            };
            map.entry(name)
                .or_default()
                .push(Symbol { file, chunk: id });
        }
    }
    fn select<'a>(map: &'a HashMap<String, Vec<Symbol>>, name: &str) -> Option<&'a Symbol> {
        let symbols = map.get(name.trim_start_matches('\\'))?;
        (symbols.len() == 1).then(|| &symbols[0])
    }
    pub fn import(
        &self,
        project: &Project<'_>,
        file: &File<'_>,
        fact: Import<'_>,
    ) -> Option<usize> {
        if runtime(fact) {
            if fact.source.starts_with('/') {
                return None;
            }
            let bases = if fact.source.starts_with('.') {
                vec![dirname(&file.path)]
            } else {
                vec![dirname(&file.path), "."]
            };
            let files = unique_files(
                project,
                bases
                    .into_iter()
                    .filter_map(|base| project.file(&join(base, fact.source)))
                    .filter(|&id| project.files[id].language == "php"),
            );
            return (files.len() == 1).then(|| files[0]);
        }
        Self::select(
            match fact.imported {
                Some("function") => &self.functions,
                Some("const") => &self.constants,
                _ => &self.types,
            },
            fact.source,
        )
        .map(|s| s.file)
    }
    pub fn local(&self, project: &Project<'_>, fact: Import<'_>) -> bool {
        if runtime(fact) {
            let root = fact.source.split('/').next().unwrap_or("");
            return fact.source.starts_with('.')
                || project.files.iter().any(|f| {
                    f.language == "php"
                        && (f.path == fact.source || f.path.starts_with(&format!("{root}/")))
                });
        }
        let root = fact
            .source
            .trim_start_matches('\\')
            .split('\\')
            .next()
            .unwrap_or("");
        self.namespaces
            .iter()
            .any(|n| n == root || n.starts_with(&format!("{root}\\")))
    }
    fn type_call(project: &Project<'_>, symbol: &Symbol, method: Option<&str>) -> Option<Target> {
        let chunks = &project.files[symbol.file].analysis.source_chunks;
        if method.is_none() || method == Some("__construct") {
            return chunk_ref(&chunks[symbol.chunk]).map(|chunk| Target {
                file: symbol.file,
                chunk,
            });
        }
        unique(
            chunks
                .iter()
                .filter(|c| {
                    c.parent == Some(symbol.chunk)
                        && c.kind == "method"
                        && c.name.as_deref() == method
                })
                .filter_map(chunk_ref)
                .map(|chunk| Target {
                    file: symbol.file,
                    chunk,
                }),
        )
    }
    pub fn call(&self, project: &Project<'_>, file_id: usize, fact: Call<'_>) -> Option<Target> {
        if !matches!(fact.binding, Binding::Unknown | Binding::Import) {
            return None;
        }
        let file = &project.files[file_id];
        let callee = fact.callee.strip_prefix('\\').unwrap_or(fact.callee);
        let namespace = file
            .analysis
            .source_chunks
            .iter()
            .filter(|c| {
                c.kind == "module"
                    && c.span.start <= fact.fact.location.start_offset
                    && c.span.end >= fact.fact.location.start_offset
            })
            .min_by_key(|c| c.span.end - c.span.start)
            .and_then(|c| c.name.as_deref())
            .filter(|n| *n != "(global)")
            .unwrap_or("")
            .trim_start_matches('\\');
        let mut candidates = Vec::new();
        let scoped = callee
            .rsplit_once("::")
            .filter(|(_, m)| !m.is_empty() && !m.contains(':'));
        let type_name = callee
            .starts_with(|c: char| c.is_ascii_uppercase() || c == '_' || c == '\\')
            && callee
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '\\');
        if scoped.is_some() || type_name {
            let (name, method) = scoped.map(|(n, m)| (n, Some(m))).unwrap_or((callee, None));
            for imported in file
                .imports
                .iter()
                .filter(|i| i.imported == Some("class") && i.local == Some(name))
            {
                if let Some(target) = Self::select(&self.types, imported.source)
                    .and_then(|s| Self::type_call(project, s, method))
                {
                    candidates.push(target);
                }
            }
            let qualified = if name.contains('\\') || namespace.is_empty() {
                name.into()
            } else {
                format!("{namespace}\\{name}")
            };
            if let Some(target) = Self::select(&self.types, &qualified)
                .and_then(|s| Self::type_call(project, s, method))
            {
                candidates.push(target);
            }
        } else if callee.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && callee
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            let qualified = if namespace.is_empty() {
                callee.into()
            } else {
                format!("{namespace}\\{callee}")
            };
            for name in file
                .imports
                .iter()
                .filter(|i| i.imported == Some("function") && i.local == Some(callee))
                .map(|i| i.source)
                .chain(std::iter::once(qualified.as_str()))
            {
                if let Some(symbol) = Self::select(&self.functions, name)
                    && let Some(chunk) =
                        chunk_ref(&project.files[symbol.file].analysis.source_chunks[symbol.chunk])
                {
                    candidates.push(Target {
                        file: symbol.file,
                        chunk,
                    });
                }
            }
        }
        unique(candidates)
    }
}
