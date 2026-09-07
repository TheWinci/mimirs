use super::*;
use std::collections::HashMap;

fn reference(value: &str) -> Option<&str> {
    let value = value.trim();
    let lower = value.to_lowercase();
    (!value.is_empty()
        && !value.starts_with('#')
        && !["data:", "javascript:", "mailto:", "tel:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        && !["{{", "}}", "${", "<%", "%>"]
            .iter()
            .any(|part| value.contains(part)))
    .then_some(value)
}

fn srcset(value: &str) -> Vec<&str> {
    let mut output = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',');
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let raw = &rest[..end];
        let url = raw.trim_end_matches(',');
        rest = &rest[end..];
        if raw.len() == url.len() {
            let mut parentheses = 0usize;
            let mut end = rest.len();
            for (index, c) in rest.char_indices() {
                match c {
                    '(' => parentheses += 1,
                    ')' => parentheses = parentheses.saturating_sub(1),
                    ',' if parentheses == 0 => {
                        end = index + 1;
                        break;
                    }
                    _ => {}
                }
            }
            rest = &rest[end..];
        }
        if let Some(url) = reference(url) {
            output.push(url);
        }
    }
    output
}

pub(super) fn extract(context: &Context<'_>, root: Node<'_>) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in walk(root)
        .into_iter()
        .filter(|node| matches!(node.kind(), "element" | "script_element" | "style_element"))
    {
        let Some(tag_node) = children(node)
            .into_iter()
            .find(|n| matches!(n.kind(), "start_tag" | "self_closing_tag"))
        else {
            continue;
        };
        let Some(tag) = children(tag_node)
            .into_iter()
            .find(|n| n.kind() == "tag_name")
            .map(|n| context.text(n).to_lowercase())
        else {
            continue;
        };
        let mut attributes = HashMap::new();
        for attribute in children(tag_node)
            .into_iter()
            .filter(|n| n.kind() == "attribute")
        {
            let Some(name) = children(attribute)
                .into_iter()
                .find(|n| n.kind() == "attribute_name")
            else {
                continue;
            };
            let value_node = children(attribute)
                .into_iter()
                .find(|n| n.kind() != "attribute_name");
            let value = value_node.map_or("", |node| {
                if node.kind() == "quoted_attribute_value" {
                    children(node)
                        .into_iter()
                        .find(|n| n.kind() == "attribute_value")
                        .map_or("", |n| context.text(n))
                } else {
                    context.text(node)
                }
            });
            attributes.insert(context.text(name).to_lowercase(), (value, attribute));
        }
        let owner = context.owner_where(node, |chunk| {
            chunk.kind != "element"
                || chunk
                    .name
                    .as_ref()
                    .is_none_or(|name| name.to_lowercase() != tag)
        });
        let mut emit = |attribute: &str, imported: &str| {
            if let Some(&(value, evidence)) = attributes.get(attribute)
                && let Some(value) = reference(value)
            {
                facts.push(context.import(value.into(), imported, evidence, owner.clone()));
            }
        };
        if tag == "script" {
            emit("src", "script");
        }
        if tag == "link" {
            let rels = attributes
                .get("rel")
                .map_or("", |(value, _)| value)
                .to_lowercase();
            for rel in ["stylesheet", "modulepreload", "preload", "icon", "manifest"] {
                if rels.split_whitespace().any(|value| value == rel) {
                    emit("href", rel);
                }
            }
        }
        let asset_attributes: &[&str] = match tag.as_str() {
            "img" | "source" | "audio" | "iframe" | "embed" | "track" => &["src"],
            "video" => &["src", "poster"],
            "object" => &["data"],
            "input"
                if attributes
                    .get("type")
                    .is_some_and(|(value, _)| value.eq_ignore_ascii_case("image")) =>
            {
                &["src"]
            }
            "image" | "use" => &["href", "xlink:href"],
            _ => &[],
        };
        for attribute in asset_attributes {
            emit(attribute, &format!("asset:{tag}.{attribute}"));
        }
        let attribute = match tag.as_str() {
            "link" => "imagesrcset",
            "img" | "source" => "srcset",
            _ => continue,
        };
        if let Some(&(value, evidence)) = attributes.get(attribute) {
            for value in srcset(value) {
                facts.push(context.import(
                    value.into(),
                    &format!("asset:{tag}.{attribute}"),
                    evidence,
                    owner.clone(),
                ));
            }
        }
    }
    facts
}
