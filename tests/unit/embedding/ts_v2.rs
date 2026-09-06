use super::*;

fn tokenizer() -> Tokenizer {
    let path=directories::BaseDirs::new().unwrap().home_dir().join(".cache/mimirs/models/Xenova/all-MiniLM-L6-v2/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        crate::storage::processing::source_hash(std::str::from_utf8(&bytes).unwrap()),
        "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"
    );
    unbounded(Tokenizer::from_bytes(bytes).unwrap()).unwrap()
}

#[test]
#[ignore = "loads cached pinned TS v2 tokenizer without inference"]
fn final_document_inputs_match_ts_text_and_token_ids() {
    let tokenizer = tokenizer();
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../benchmarks/versions/port/reference.json"
    ))
    .unwrap();
    for case in reference["tokenInputs"].as_array().unwrap() {
        let windows = document_inputs(&tokenizer, case["text"].as_str().unwrap()).unwrap();
        let expected = case["windows"].as_array().unwrap();
        assert_eq!(windows.len(), expected.len());
        for (window, expected) in windows.iter().zip(expected) {
            assert_eq!(window, expected["text"].as_str().unwrap());
            assert_eq!(
                serde_json::json!(ids(&tokenizer, window).unwrap()),
                expected["ids"]
            );
        }
    }
    let long_path = format!("File: {}.rs\nsource", "directory/".repeat(300));
    assert!(document_inputs(&tokenizer, &long_path).is_err());
}

#[test]
fn float32_merge_preserves_normalization_and_duplicate_weight() {
    let mut a = vec![0.0; crate::embedding::DIMENSION];
    a[0] = 1.0;
    let mut b = vec![0.0; crate::embedding::DIMENSION];
    b[1] = 1.0;
    let merged = merge(&[&a, &a, &b]).unwrap();
    assert!((merged[0] - 2.0 / 5.0_f32.sqrt()).abs() < 1e-6);
    assert!((merged[1] - 1.0 / 5.0_f32.sqrt()).abs() < 1e-6);
    assert_eq!(merge(&[&a]).unwrap(), a);
    assert!(merge(&[]).is_err());
}

#[test]
#[ignore = "runs pinned q8 model against captured TS singleton/averaged documents and long queries"]
fn real_model_inputs_and_vectors_match_ts_reference() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../benchmarks/versions/port/model-reference.json"
    ))
    .unwrap();
    let mut model = crate::embedding::production().unwrap().with_workers(2);
    let tokenizer = unbounded(model.backend.tokenizer().unwrap()).unwrap();
    for case in reference["documents"].as_array().unwrap() {
        let inputs = document_inputs(&tokenizer, case["text"].as_str().unwrap()).unwrap();
        let expected = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|b| b.as_array().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(inputs.len(), expected.len());
        for (input, expected) in inputs.iter().zip(expected) {
            assert_eq!(input, expected["text"].as_str().unwrap());
            assert_eq!(
                serde_json::json!(ids(&tokenizer, input).unwrap()),
                expected["ids"]
            );
        }
        let vectors = model
            .embed_ts_documents(&[case["text"].as_str().unwrap().into()], |_, _| Ok(()))
            .unwrap();
        check_vector(&vectors[0], &case["vector"]);
    }
    for case in reference["queries"].as_array().unwrap() {
        let mut inputs = query_inputs(&tokenizer, case["text"].as_str().unwrap()).unwrap();
        inputs.sort_by_key(|(_, count)| *count);
        let expected = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|b| b.as_array().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(inputs.len(), expected.len());
        for ((input, _), expected) in inputs.iter().zip(expected) {
            assert_eq!(input, expected["text"].as_str().unwrap());
            assert_eq!(
                serde_json::json!(ids(&tokenizer, input).unwrap()),
                expected["ids"]
            );
        }
        check_vector(
            &model
                .embed_ts_query(case["text"].as_str().unwrap())
                .unwrap(),
            &case["vector"],
        );
    }
}

fn check_vector(actual: &[f32], expected: &serde_json::Value) {
    let expected: Vec<f64> = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(actual.len(), expected.len());
    let error = actual
        .iter()
        .zip(&expected)
        .map(|(&a, &b)| (a as f64 - b).abs())
        .fold(0.0_f64, f64::max);
    let dot: f64 = actual
        .iter()
        .zip(&expected)
        .map(|(&a, &b)| a as f64 * b)
        .sum();
    let norm: f64 = actual.iter().map(|&a| (a as f64) * (a as f64)).sum::<f64>()
        * expected.iter().map(|&v| v * v).sum::<f64>();
    let cosine = dot / norm.sqrt();
    eprintln!("TS vector parity: maximum component error {error:e}, cosine {cosine:.12}");
    assert!(error <= 1e-5, "component error {error}");
    assert!(cosine >= 0.999999, "cosine {cosine}");
}
