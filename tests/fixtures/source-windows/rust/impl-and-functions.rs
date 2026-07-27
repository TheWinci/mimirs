/// A report assembled from ordered lines.
pub struct Report {
    title: String,
    lines: Vec<String>,
}

impl Report {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), lines: Vec::new() }
    }

    pub fn push(&mut self, line: impl Into<String>) {
        self.lines.push(line.into());
    }

    pub fn render(&self) -> String {
        let mut output = vec![self.title.clone()];
        output.extend(self.lines.iter().map(|line| format!("- {line}")));
        output.join("\n")
    }
}

pub fn normalize_title(value: &str) -> String {
    value.trim().to_uppercase()
}
