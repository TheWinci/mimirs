//! Signals from chunk names (ranking plan S6 and S7): score multipliers for
//! found chunks whose names the query spells.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use regex::Regex;

use crate::keywords;
use crate::store::{ChunkName, Store};

/// Score multiplier for a chunk that alone defines a code identifier the query
/// spells (S6, TS v2's value).
const UNIQUE_SYMBOL_MULTIPLIER: f32 = 1.3;

/// Score multiplier for a chunk whose name the query contains (S7, TS v2's
/// value).
const EXACT_NAME_MULTIPLIER: f32 = 1.2;

/// Words that look like identifiers in a question but rarely name the code
/// asked about (TS v2's list).
const STOP_WORDS: [&str; 56] = [
    "the", "and", "for", "from", "with", "that", "this", "what", "when", "where", "how", "all",
    "not", "but", "has", "have", "get", "set", "new", "use", "can", "will", "should", "into",
    "each", "only", "does", "file", "files", "code", "function", "method", "class", "type",
    "return", "error", "value", "data", "name", "path", "index", "query", "result", "results",
    "search", "find", "create", "update", "delete", "remove", "add", "list", "check", "test",
    "run", "build",
];

/// Multiply the score of each found chunk whose name is a code identifier
/// from `query` that no other file defines (S6).
pub fn unique_symbols(
    query: &str,
    found_chunks: &HashSet<i64>,
    store: &Store,
    multipliers: &mut HashMap<i64, f32>,
) -> Result<()> {
    for identifier in definition_identifiers(query)? {
        // A dotted identifier names a member: look up its last part, then
        // compare full names.
        let own_name = identifier.rsplit('.').next().unwrap_or_default();
        let mut matching = store.chunks_named(own_name)?;
        if identifier.contains('.') {
            let ids: Vec<i64> = matching.iter().map(|(_, chunk_id)| *chunk_id).collect();
            let names = store.chunk_names(&ids)?;
            matching.retain(|(_, chunk_id)| {
                names
                    .get(chunk_id)
                    .is_some_and(|name| name.full.eq_ignore_ascii_case(&identifier))
            });
        }
        let files: HashSet<&str> = matching.iter().map(|(path, _)| path.as_str()).collect();
        if files.len() != 1 {
            continue;
        }
        for (_, chunk_id) in &matching {
            if found_chunks.contains(chunk_id) {
                *multipliers.entry(*chunk_id).or_insert(1.0) *= UNIQUE_SYMBOL_MULTIPLIER;
            }
        }
    }
    Ok(())
}

/// Multiply the score of each named chunk whose full name's terms all appear
/// among the query's terms (S7).
pub fn exact_names(
    query: &str,
    names: &HashMap<i64, ChunkName>,
    multipliers: &mut HashMap<i64, f32>,
) {
    let query_terms = keywords::terms(query);
    for (chunk_id, name) in names {
        let name_terms = keywords::terms(&name.full);
        if name_terms.is_empty() {
            continue;
        }
        let named_by_query = name_terms.iter().all(|term| query_terms.contains(term));
        if named_by_query {
            *multipliers.entry(*chunk_id).or_insert(1.0) *= EXACT_NAME_MULTIPLIER;
        }
    }
}

/// Query words spelled like code: 3 or more characters with a capital letter,
/// `_`, or one `.`, not a stop word, and not all capitals (`STATIC_URL` names
/// a use site more often than a definition). Each once, in query order.
fn definition_identifiers(query: &str) -> Result<Vec<String>> {
    let identifier = Regex::new(r"\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?\b")?;
    let constant = Regex::new(r"^[A-Z][A-Z0-9_]*$")?;
    let mut identifiers: Vec<String> = Vec::new();
    for found in identifier.find_iter(query) {
        let word = found.as_str();
        let looks_like_code = word.chars().any(|character| character.is_ascii_uppercase())
            || word.contains('_')
            || word.contains('.');
        let is_stop_word = STOP_WORDS.contains(&word.to_lowercase().as_str());
        if word.len() >= 3
            && looks_like_code
            && !is_stop_word
            && !constant.is_match(word)
            && !identifiers.iter().any(|known| known == word)
        {
            identifiers.push(word.to_string());
        }
    }
    Ok(identifiers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raised(query: &str) -> Vec<i64> {
        let names = HashMap::from([
            (
                1,
                ChunkName {
                    full: "Queue.drain".into(),
                },
            ),
            (
                2,
                ChunkName {
                    full: "Graph.getDependsOn".into(),
                },
            ),
        ]);
        let mut multipliers = HashMap::new();
        exact_names(query, &names, &mut multipliers);
        let mut ids: Vec<i64> = multipliers.into_keys().collect();
        ids.sort_unstable();
        ids
    }

    #[test]
    fn a_chunk_is_raised_when_the_query_has_every_word_of_its_full_name() {
        assert_eq!(raised("drain the queue"), [1]);
        assert!(raised("drain the tasks").is_empty());
        assert_eq!(raised("what does the graph get it depends on"), [2]);
    }

    #[test]
    fn identifiers_need_a_code_spelling() -> Result<()> {
        assert_eq!(
            definition_identifiers(
                "How does getDependsOn call Queue.drain and run_tasks with STATIC_URL in Get?"
            )?,
            ["getDependsOn", "Queue.drain", "run_tasks"]
        );
        Ok(())
    }
}
