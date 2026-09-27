/// Split `text` into lowercase search terms: runs of letters and digits, cut
/// again at identifier case boundaries, without 1-character pieces. Paths,
/// chunk text, and queries all go through here so their terms match.
pub fn terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for word in text.split(|character: char| !character.is_alphanumeric()) {
        for piece in split_identifier(word) {
            if piece.chars().count() > 1 {
                terms.push(piece.to_lowercase());
            }
        }
    }
    terms
}

/// An FTS5 query matching chunks that contain any of the query's terms, or
/// `None` when the query has no terms.
pub fn match_expression(query: &str) -> Option<String> {
    let mut distinct_terms: Vec<String> = Vec::new();
    for term in terms(query) {
        if !distinct_terms.contains(&term) {
            distinct_terms.push(term);
        }
    }
    if distinct_terms.is_empty() {
        return None;
    }
    // Quoting keeps words like `not` from being read as operators; terms hold
    // only letters and digits, so they never contain a quote. FTS5 joins bare
    // terms with AND, which would leave long questions matching nothing.
    let quoted: Vec<String> = distinct_terms
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect();
    Some(quoted.join(" OR "))
}

/// Cut `getDependsOn` into `get`, `Depends`, `On` and `HTMLParser` into `HTML`,
/// `Parser`.
fn split_identifier(word: &str) -> Vec<&str> {
    let characters: Vec<(usize, char)> = word.char_indices().collect();
    let mut pieces = Vec::new();
    let mut piece_start = 0;
    for position in 1..characters.len() {
        let (offset, current) = characters[position];
        let previous = characters[position - 1].1;
        let next = characters
            .get(position + 1)
            .map(|&(_, character)| character);
        let after_lowercase =
            (previous.is_lowercase() || previous.is_numeric()) && current.is_uppercase();
        // The last capital of an acronym starts the next word: HTML|Parser.
        let ends_acronym = previous.is_uppercase()
            && current.is_uppercase()
            && next.is_some_and(char::is_lowercase);
        if after_lowercase || ends_acronym {
            pieces.push(&word[piece_start..offset]);
            piece_start = offset;
        }
    }
    pieces.push(&word[piece_start..]);
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_split_into_lowercase_words() {
        assert_eq!(terms("getDependsOn"), ["get", "depends", "on"]);
        assert_eq!(terms("HTMLParser"), ["html", "parser"]);
        assert_eq!(terms("snake_case_name"), ["snake", "case", "name"]);
        assert_eq!(terms("config.threadCount"), ["config", "thread", "count"]);
    }

    #[test]
    fn paths_split_into_words() {
        assert_eq!(
            terms("src/search/hybrid.ts"),
            ["src", "search", "hybrid", "ts"]
        );
    }

    #[test]
    fn single_characters_and_punctuation_are_dropped() {
        assert_eq!(terms("let x = a + bc; // X-ray"), ["let", "bc", "ray"]);
    }

    #[test]
    fn a_query_matches_any_of_its_distinct_terms() {
        assert_eq!(
            match_expression("rrfFuse NOT fuse-ranks").as_deref(),
            Some("\"rrf\" OR \"fuse\" OR \"not\" OR \"ranks\"")
        );
    }

    #[test]
    fn a_query_without_terms_has_no_expression() {
        assert_eq!(match_expression(""), None);
        assert_eq!(match_expression("- : * \" ( )"), None);
    }

    #[test]
    fn digits_stay_with_their_word() {
        assert_eq!(terms("sha256 v2Rust"), ["sha256", "v2", "rust"]);
    }
}
