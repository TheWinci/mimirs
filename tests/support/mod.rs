use anyhow::ensure;

pub fn cosine_similarity(left: &[f32], right: &[f32]) -> anyhow::Result<f32> {
    ensure!(!left.is_empty(), "cosine vectors cannot be empty");
    ensure!(
        left.len() == right.len(),
        "cosine vectors have different dimensions: {} and {}",
        left.len(),
        right.len()
    );
    ensure!(
        left.iter().chain(right).all(|value| value.is_finite()),
        "cosine vectors contain a non-finite value"
    );

    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();

    ensure!(
        left_norm > 0.0 && right_norm > 0.0,
        "cosine vectors must have non-zero magnitude"
    );

    Ok((dot / (left_norm * right_norm)).clamp(-1.0, 1.0))
}

#[test]
fn scalar_cosine_handles_known_vectors() {
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]).unwrap(), 1.0);
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).unwrap(), 0.0);
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]).unwrap(), -1.0);
}

pub fn tokenizer(limit: usize) -> tokenizers::Tokenizer {
    use tokenizers::{
        TruncationParams, models::wordlevel::WordLevel, pre_tokenizers::whitespace::Whitespace,
        processors::bert::BertProcessing,
    };
    let model = WordLevel::builder()
        .vocab(
            [
                ("[UNK]".into(), 0),
                ("[CLS]".into(), 1),
                ("[SEP]".into(), 2),
            ]
            .into_iter()
            .collect(),
        )
        .unk_token("[UNK]".into())
        .build()
        .unwrap();
    let mut tokenizer = tokenizers::Tokenizer::new(model);
    tokenizer.with_pre_tokenizer(Some(Whitespace));
    tokenizer.with_post_processor(Some(BertProcessing::new(
        ("[SEP]".into(), 2),
        ("[CLS]".into(), 1),
    )));
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: limit,
            ..Default::default()
        }))
        .unwrap();
    tokenizer
}
