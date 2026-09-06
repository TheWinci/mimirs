use super::*;

fn extract(text: &str) -> Analysis {
    crate::analysis::extract(crate::source::SourceFile {
        path: "src/example.rs".into(),
        text: text.into(),
    })
    .unwrap()
}

fn budget(limit: usize) -> TokenBudget {
    TokenBudget::new(crate::test_support::tokenizer(limit)).unwrap()
}

#[test]
fn small_functions_keep_docs_operators_and_macro_arguments_verbatim() {
    let source = "/// Reject trailing newlines.\n#[inline]\nfn valid_username(name: &str) -> bool {\n    !name.ends_with('\\n')\n}\n\nfn diagnostic() { writeln!(out, \"{}\", plain(message))?; }";
    let analysis = extract(source);
    let docs = documents(&analysis, &budget(512)).unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(
        docs[0].text,
        format!(
            "src/example.rs\n{}",
            &source[..source.find("\n\n").unwrap()]
        )
    );
    assert!(
        docs[1]
            .text
            .contains("writeln!(out, \"{}\", plain(message))?;")
    );
    assert!(docs.iter().all(|d| d.owner.is_some() && d.part == 0));
    crate::storage::documents::validate(&analysis, &docs).unwrap();
}

#[test]
fn containers_partition_source_without_copying_child_bodies() {
    let analysis = extract(
        "//! Module docs\nuse a::B;\nmod m {\nstruct S { value: i32 }\nimpl S {\n/// Check it.\nfn check(&self) -> bool { fn nested() {} self.value > 0 }\nfn other() {}\n}\n}\n// tail\n",
    );
    let chunks = chunks(&analysis).unwrap();
    let method = chunks.iter().find(|c| c.text.contains("fn check")).unwrap();
    assert_eq!(method.context, "src/example.rs :: module m :: impl S");
    assert!(method.text.starts_with("/// Check it."));
    assert!(method.text.contains("fn nested() {}"));
    assert_eq!(
        chunks
            .iter()
            .filter(|c| c.text.contains("fn nested"))
            .count(),
        1
    );
    assert_eq!(
        chunks
            .iter()
            .filter(|c| c.text.contains("fn other"))
            .count(),
        1
    );
    let mut end = 0;
    for chunk in &chunks {
        assert!(
            analysis.source.text[end..chunk.span.start]
                .trim()
                .is_empty()
        );
        assert_eq!(
            chunk.text,
            analysis.source.text[chunk.span.start..chunk.span.end]
        );
        end = chunk.span.end;
    }
    assert!(analysis.source.text[end..].trim().is_empty());
}

#[test]
fn oversized_functions_repeat_signature_and_split_on_lines() {
    let source = format!(
        "fn process(value: i32) -> Result<()> {{\n{}    Ok(())\n}}",
        "    check(value)?;\n".repeat(80)
    );
    let analysis = extract(&source);
    let budget = budget(64);
    let docs = documents(&analysis, &budget).unwrap();
    assert!(docs.len() > 2);
    let mut restored = String::new();
    for (part, doc) in docs.iter().enumerate() {
        assert_eq!(doc.part, part);
        assert!(
            doc.text
                .starts_with("src/example.rs\nfn process(value: i32) -> Result<()>\n")
        );
        assert!(budget.count(&doc.text).unwrap() <= budget.limit);
        let span = &doc.evidence[0].span;
        restored.push_str(&source[span.start..span.end]);
        if part + 1 < docs.len() {
            assert!(source[..span.end].ends_with('\n'));
        }
    }
    assert_eq!(restored, source);
    crate::storage::documents::validate(&analysis, &docs).unwrap();
}

#[test]
fn oversized_unicode_lines_and_signatures_preserve_every_source_byte() {
    let source = format!(
        "fn long({}) {{ let text = \"{}\"; }}",
        (0..90)
            .map(|i| format!("arg{i}: &str"))
            .collect::<Vec<_>>()
            .join(", "),
        "żółć 日本語 ".repeat(100)
    );
    let mut analysis = extract(&source);
    analysis.source.path = "long/path/".repeat(50) + "file.rs";
    let budget = budget(64);
    let docs = documents(&analysis, &budget).unwrap();
    assert!(docs.len() > 1);
    let restored: String = docs
        .iter()
        .map(|d| {
            assert!(budget.count(&d.text).unwrap() <= budget.limit);
            let span = &d.evidence[0].span;
            &source[span.start..span.end]
        })
        .collect();
    assert_eq!(restored, source);
    assert_eq!(docs, documents(&analysis, &budget).unwrap());
}

#[test]
fn file_only_and_incomplete_source_remain_searchable() {
    for source in [
        "use crate::Thing;\n// file comment",
        "fn broken(\n",
        "! @ malformed",
        "// comment only\r\n",
    ] {
        let analysis = extract(source);
        let docs = documents(&analysis, &budget(512)).unwrap();
        assert!(!docs.is_empty(), "{source}");
        let restored: String = docs
            .iter()
            .map(|d| {
                let span = &d.evidence[0].span;
                &source[span.start..span.end]
            })
            .collect();
        assert_eq!(restored.trim(), source.trim());
        crate::storage::documents::validate(&analysis, &docs).unwrap();
    }
    assert!(
        documents(&extract(" \n\t"), &budget(512))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn source_evidence_rejects_invalid_byte_and_line_ranges() {
    let analysis = extract("fn f() { let s = \"żółć\"; }");
    let docs = documents(&analysis, &budget(512)).unwrap();
    for span in [
        Span {
            start: 0,
            end: 999,
            line_start: 1,
            line_end: 1,
        },
        Span {
            start: 0,
            end: 1,
            line_start: 2,
            line_end: 2,
        },
        Span {
            start: 18,
            end: 19,
            line_start: 1,
            line_end: 1,
        },
    ] {
        let mut invalid = docs.clone();
        invalid[0].evidence[0].span = span;
        assert!(crate::storage::documents::validate(&analysis, &invalid).is_err());
    }
}

#[test]
fn overlapping_sibling_records_fail_without_slicing_invalid_ranges() {
    let mut analysis = extract("fn a() {} fn b() {}");
    analysis.entities[1].span = analysis.entities[0].span.clone();
    assert!(chunks(&analysis).is_err());
}

#[test]
fn unsupported_text_keeps_paragraphs_and_splits_only_when_needed() {
    let text = "\r\nfirst line\r\nsecond line\r\n \r\nżółć 日本語\nlast line\n";
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "notes.txt".into(),
        text: text.into(),
    })
    .unwrap();
    assert!(analysis.entities.is_empty() && analysis.facts.is_empty());
    assert_eq!(analysis.scopes.len(), 1);
    assert!(crate::analysis::report(&analysis).contains("not parsed"));
    let chunks = chunks(&analysis).unwrap();
    assert_eq!(
        chunks.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
        ["first line\r\nsecond line\r\n", "żółć 日本語\nlast line\n"]
    );
    assert!(
        chunks
            .iter()
            .all(|c| c.owner.is_none() && c.signature.is_none())
    );
    let docs = documents(&analysis, &budget(512)).unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0].text, "notes.txt\nfirst line\r\nsecond line\r\n");
    assert_eq!(docs.iter().map(|d| d.part).collect::<Vec<_>>(), [0, 1]);
    for text in ["", " \r\n\t", &"żółć 東京 ".repeat(1000)] {
        let analysis = crate::analysis::extract(crate::source::SourceFile {
            path: "notes.txt".into(),
            text: text.into(),
        })
        .unwrap();
        let budget = budget(32);
        let docs = documents(&analysis, &budget).unwrap();
        assert!(docs.iter().all(|d| budget.count(&d.text).unwrap() <= 32));
        let restored: String = docs
            .iter()
            .map(|d| {
                let s = &d.evidence[0].span;
                &text[s.start..s.end]
            })
            .collect();
        assert_eq!(restored.trim(), text.trim());
    }
}

#[test]
fn complete_source_inputs_fit_at_limit_and_split_one_token_over() {
    let budget = budget(32);
    assert_eq!(budget.count("hello").unwrap(), 3);
    let mut text = String::new();
    while budget.count(&format!("notes.txt\n{text}x ")).unwrap() <= 32 {
        text.push_str("x ");
    }
    let make = |text| {
        crate::analysis::extract(crate::source::SourceFile {
            path: "notes.txt".into(),
            text,
        })
        .unwrap()
    };
    let docs = documents(&make(text.clone()), &budget).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(budget.count(&docs[0].text).unwrap(), 32);
    text.push('x');
    assert_eq!(documents(&make(text), &budget).unwrap().len(), 2);
}

#[test]
#[ignore = "loads the cached MiniLM model; run explicitly"]
fn real_model_source_inputs_preserve_bytes_without_truncation() {
    let mut embedder = crate::embedding::production().unwrap();
    let budget = embedder.token_budget().unwrap();
    assert_eq!(budget.limit, 512);
    let source = format!(
        "/// {}\nfn long() {{ helper(); }}",
        "Café 東京 identifiers ".repeat(800)
    );
    let docs = documents(&extract(&source), &budget).unwrap();
    assert!(docs.len() > 2);
    let mut restored = String::new();
    for doc in &docs {
        assert!(budget.count(&doc.text).unwrap() <= 512);
        let span = &doc.evidence[0].span;
        restored.push_str(&source[span.start..span.end]);
    }
    assert_eq!(restored, source);
    let texts: Vec<_> = docs.into_iter().map(|d| d.text).collect();
    assert_eq!(
        embedder
            .embed_documents(&texts, |_, _| Ok(()))
            .unwrap()
            .len(),
        texts.len()
    );
}

#[test]
fn declaration_rules_control_containers_attachment_and_signatures() {
    let mut analysis = extract("mod C {\n#[inline]\nfn work() {}\nfn other() {}\n}");
    // Use unfamiliar kinds to catch assumptions about Rust in shared chunking.
    analysis.source.path = "example.test".into();
    analysis.entities[0].kind = "class".into();
    for fact in &mut analysis.facts {
        if fact.kind == "attribute" {
            fact.kind = "decorator".into();
        }
        if fact.kind == "signature" {
            fact.kind = "header".into();
        }
    }
    let rules = DeclarationRules {
        containers: &["class"],
        leading_facts: &["decorator"],
        signature_fact: "header",
    };
    let chunks = chunks_with(&analysis, Chunking::Declarations(rules)).unwrap();
    let method = chunks.iter().find(|chunk| chunk.owner == Some(1)).unwrap();
    assert_eq!(method.text, "#[inline]\nfn work() {}");
    assert_eq!(method.context, "example.test :: class C");
    let signature = method.signature.as_ref().unwrap();
    assert_eq!(
        &analysis.source.text[signature.start..signature.end],
        "fn work() "
    );
    let mut position = 0;
    for chunk in &chunks {
        assert!(chunk.span.start >= position);
        assert!(
            analysis.source.text[position..chunk.span.start]
                .trim()
                .is_empty()
        );
        assert_eq!(
            chunk.text,
            analysis.source.text[chunk.span.start..chunk.span.end]
        );
        position = chunk.span.end;
    }
    assert!(analysis.source.text[position..].trim().is_empty());
    let leaves = chunks_with(
        &analysis,
        Chunking::Declarations(DeclarationRules {
            containers: &[],
            ..rules
        }),
    )
    .unwrap();
    assert_eq!(leaves.len(), 1);
    assert_eq!(leaves[0].owner, Some(0));
    assert!(leaves[0].text.contains("fn work()"));
    assert!(leaves[0].text.contains("fn other()"));
}
