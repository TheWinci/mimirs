//! Human context presentation. Claims remain whole and source ranges remain indexed.
use serde_json::Value;
use std::fmt::Write;
fn label(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or("unknown")
        .chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}
pub(crate) fn render(value: &Value, budget: usize) -> String {
    let mut out = String::new();
    let knowledge = &value["knowledge"];
    let _ = writeln!(out, "Knowledge: {}", label(&knowledge["status"]));
    for key in ["error", "reason"] {
        if knowledge[key].is_string() {
            let _ = writeln!(out, "{}", label(&knowledge[key]));
        }
    }
    if let Some(items) = knowledge["items"].as_array() {
        for item in items {
            let _ = writeln!(
                out,
                "\n[{}] {}\nClaim: {}",
                label(&item["status"]),
                item["statement"].as_str().unwrap_or(""),
                label(&item["id"])
            );
            if let Some(evidence) = item["evidence"].as_array() {
                for edge in evidence {
                    let _ = writeln!(
                        out,
                        "  {} [{}]",
                        label(&edge["path"]),
                        label(&edge["comparison"])
                    );
                }
            }
            if item["reason"].is_string() {
                let _ = writeln!(out, "{}", label(&item["reason"]));
            }
        }
    }
    if knowledge["omitted_items"].as_u64().unwrap_or(0) > 0 || knowledge["metadata_omitted"] == true
    {
        let _ = writeln!(
            out,
            "Knowledge omitted: {}. Use knowledge maintenance for complete support.",
            knowledge["omitted_items"]
        );
    }
    if let Some(nav) = value.get("navigation") {
        let _ = writeln!(out, "\nArchitecture navigation: {}", label(&nav["status"]));
        if nav["snapshot"].is_string() {
            let _ = writeln!(
                out,
                "Indexed relationship snapshot: {}",
                label(&nav["snapshot"])
            );
        }
        if let Some(hashes) = nav["source_hashes"].as_object() {
            for (path, hash) in hashes {
                let _ = writeln!(
                    out,
                    "{} [source snapshot {}]",
                    label(&Value::String(path.clone())),
                    label(hash)
                );
            }
        }
        if let Some(operations) = nav["operations"].as_array() {
            for op in operations {
                let _ = writeln!(
                    out,
                    "{} {}: {}:{}-{}",
                    label(&op["kind"]),
                    label(&op["name"]),
                    label(&op["path"]),
                    op["lines"][0],
                    op["lines"][1]
                );
            }
        }
        if let Some(edges) = nav["edges"].as_array() {
            for edge in edges {
                let from = &edge["from"];
                let to = &edge["to"];
                let origin = format!(
                    "{}:{}-{}",
                    label(&from["path"]),
                    from["lines"][0],
                    from["lines"][1]
                );
                if edge["kind"] == "call" {
                    let _ = writeln!(
                        out,
                        "{} ({origin}) -> {} ({}:{}-{}) [resolved call]",
                        label(&from["name"]),
                        label(&to["name"]),
                        label(&to["path"]),
                        to["lines"][0],
                        to["lines"][1]
                    );
                } else {
                    let verb = if edge["kind"] == "import" {
                        "imports"
                    } else {
                        "references"
                    };
                    let _ = writeln!(
                        out,
                        "{origin} {verb} {} [{}]",
                        label(&to["path"]),
                        label(&edge["kind"])
                    );
                }
            }
        }
        if let Some(gaps) = nav["gaps"].as_array() {
            for gap in gaps {
                let _ = writeln!(out, "Gap: {}", label(gap));
            }
        }
        for field in ["omitted_edges", "omitted_operations"] {
            if nav[field].as_u64().unwrap_or(0) > 0 {
                let _ = writeln!(out, "{field}: {}", nav[field]);
            }
        }
    }
    let source = &value["source"];
    let _ = writeln!(out, "\nSource: {}", label(&source["status"]));
    for key in ["error", "reason"] {
        if source[key].is_string() {
            let _ = writeln!(out, "{}", label(&source[key]));
        }
    }
    if let Some(current) = source["current"].as_array() {
        for file in current {
            let _ = writeln!(
                out,
                "{}: working file {}",
                label(&file["path"]),
                label(&file["comparison"])
            );
        }
    }
    if let Some(text) = source["text"].as_str() {
        out.push_str(text);
    }
    if source["omitted"].is_boolean() || source["metadata_omitted"] == true {
        out.push_str("Source omitted to fit the response budget.\n");
    }
    out.push_str("\nEvidence status checks declared support, not claim truth or unlisted dependencies. Reads do not record reviews.\n");
    // Never emit terminal controls from source or claims. Preserve source newlines and tabs.
    let out: String = out
        .chars()
        .flat_map(|c| {
            if c.is_control() && !matches!(c, '\n' | '\t') {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect();
    if out.len() <= budget {
        out
    } else {
        "Context metadata exceeds the readable response budget. Use --output json or increase --max-bytes; no partial claim is shown.\n".into()
    }
}
