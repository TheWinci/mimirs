use crate::excerpt::ShownFile;

/// Longest line in the file map, in bytes; longer summaries are cut.
const MAP_LINE_BYTES: usize = 120;

/// Print the file map, then excerpts in rank order, within `budget` bytes.
/// One file's excerpts use at most a quarter of the budget.
pub fn render(index_age_seconds: Option<u64>, files: &[ShownFile], budget: usize) -> String {
    let mut output = match index_age_seconds {
        Some(seconds) => format!("Index updated {}\n", describe_age(seconds)),
        None => "Index update time unknown\n".to_string(),
    };

    output.push_str("\nRelevant files\n");
    for (position, file) in files.iter().enumerate() {
        output.push_str(&map_line(position + 1, file));
        output.push('\n');
    }

    output.push_str("\nExcerpts\n");
    let per_file_cap = budget / 4;
    for file in files {
        let remaining = budget.saturating_sub(output.len());
        let mut allowance = per_file_cap.min(remaining);
        for excerpt in &file.excerpts {
            let range = format!("{}:{}-{}", file.path, excerpt.start_line, excerpt.end_line);
            let header = format!("\n{range}\n");
            let marker = format!("[cut; read {range} for the rest]\n");
            // Only start an excerpt when its header and a possible cut marker fit.
            if header.len() + marker.len() + 1 > allowance {
                break;
            }
            output.push_str(&header);
            allowance -= header.len();

            let mut text = excerpt.text.clone();
            if !text.ends_with('\n') {
                text.push('\n');
            }
            if text.len() <= allowance {
                output.push_str(&text);
                allowance -= text.len();
                continue;
            }
            let part = cut_at_line(&text, allowance - marker.len() - 1);
            output.push_str(part);
            if !part.is_empty() && !part.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&marker);
            break;
        }
    }
    output
}

/// `  3. path:line  ` followed by the names of the file's matching symbols, as
/// many whole names as fit, or by the best chunk's first line when it has no
/// name.
fn map_line(number: usize, file: &ShownFile) -> String {
    let mut line = format!("{number:>3}. {}:{}  ", file.path, file.summary_line);
    if file.names.is_empty() {
        line.push_str(&file.summary);
        return cut_to_bytes(&line, MAP_LINE_BYTES).to_string();
    }
    for (index, name) in file.names.iter().enumerate() {
        let separator = if index == 0 { "" } else { ", " };
        let fits = line.len() + separator.len() + name.len() <= MAP_LINE_BYTES;
        if !fits && index > 0 {
            break;
        }
        line.push_str(separator);
        line.push_str(name);
    }
    cut_to_bytes(&line, MAP_LINE_BYTES).to_string()
}

fn describe_age(seconds: u64) -> String {
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    if minutes < 1 {
        "just now".to_string()
    } else if hours < 1 {
        format!("{minutes} minutes ago")
    } else if days < 1 {
        format!("{hours} hours ago")
    } else {
        format!("{days} days ago")
    }
}

/// The longest prefix of `text` within `max_bytes` that ends on a character boundary.
fn cut_to_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Like `cut_to_bytes`, but ending after a whole line when one fits.
fn cut_at_line(text: &str, max_bytes: usize) -> &str {
    let prefix = cut_to_bytes(text, max_bytes);
    match prefix.rfind('\n') {
        Some(position) => &prefix[..=position],
        None => prefix,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::excerpt::Excerpt;

    fn file(path: &str, excerpts: Vec<(usize, usize, String)>) -> ShownFile {
        ShownFile {
            path: path.into(),
            summary_line: excerpts[0].0,
            names: Vec::new(),
            summary: "fn example()".into(),
            excerpts: excerpts
                .into_iter()
                .map(|(start_line, end_line, text)| Excerpt {
                    start_line,
                    end_line,
                    text,
                })
                .collect(),
        }
    }

    fn lines(count: usize) -> String {
        (1..=count)
            .map(|number| format!("line {number}\n"))
            .collect()
    }

    #[test]
    fn prints_the_map_then_excerpts() {
        let files = [
            file("src/a.rs", vec![(1, 3, lines(3))]),
            file("src/b.rs", vec![(10, 11, lines(2))]),
        ];
        let output = render(Some(120), &files, 16_000);
        assert!(output.starts_with("Index updated 2 minutes ago\n"));
        assert!(output.contains("  1. src/a.rs:1  fn example()\n  2. src/b.rs:10  fn example()\n"));
        assert!(output.contains("\nsrc/a.rs:1-3\nline 1\nline 2\nline 3\n"));
        let map_position = output.find("Relevant files").unwrap();
        let excerpt_position = output.find("Excerpts").unwrap();
        assert!(map_position < excerpt_position);
    }

    #[test]
    fn a_map_line_lists_as_many_whole_names_as_fit() {
        let mut shown = file("src/queue.ts", vec![(3, 9, lines(7))]);
        shown.names = vec!["Queue.drain".into(), "Queue".into(), "x".repeat(100)];
        let output = render(None, &[shown], 16_000);
        assert!(
            output.contains("  1. src/queue.ts:3  Queue.drain, Queue\n"),
            "{output}"
        );
    }

    #[test]
    fn one_file_uses_at_most_a_quarter_of_the_budget() {
        let files = [
            file("big.rs", vec![(1, 500, lines(500))]),
            file("small.rs", vec![(1, 2, lines(2))]),
        ];
        let output = render(None, &files, 4_000);
        let big_start = output.find("\nbig.rs:1-500\n").unwrap();
        let small_start = output.find("\nsmall.rs:1-2\n").unwrap();
        assert!(small_start - big_start <= 1_000);
        assert!(output.contains("[cut; read big.rs:1-500 for the rest]\n"));
        assert!(output.len() <= 4_000);
    }

    #[test]
    fn stays_within_the_budget() {
        let files: Vec<ShownFile> = (0..10)
            .map(|number| file(&format!("f{number}.rs"), vec![(1, 200, lines(200))]))
            .collect();
        let output = render(Some(0), &files, 3_000);
        assert!(output.len() <= 3_000);
    }

    #[test]
    fn cuts_at_line_ends_and_character_boundaries() {
        assert_eq!(cut_at_line("one\ntwo\nthree\n", 9), "one\ntwo\n");
        assert_eq!(cut_at_line("abcdef", 3), "abc");
        assert_eq!(cut_to_bytes("żółw", 3), "ż");
    }
}
